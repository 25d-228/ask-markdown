import * as vscode from 'vscode';
import MarkdownIt from 'markdown-it';
import {
	handleAskAboutSelection,
	type AskAboutSelectionMessage,
} from './selectionBridge';

type Token = Parameters<MarkdownIt['renderer']['render']>[0][number];

/**
 * A WebviewPanel paired with the source TextDocument it is previewing.
 * Phase 4 reads `sourceDocument` from the panel to map selections back to
 * editor ranges.
 */
export interface AskMarkdownPanel {
	panel: vscode.WebviewPanel;
	sourceDocument: vscode.TextDocument;
}

const VIEW_TYPE = 'askMarkdownPreview';

/**
 * Build a markdown-it instance whose block-level opening tags carry
 * `data-source-line` / `data-source-line-end` attributes derived from
 * `token.map`. The webview reads these to map a DOM selection back to a
 * source line range.
 */
function createMarkdownIt(): MarkdownIt {
	const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

	const injectSourceMap = (tokens: Token[], idx: number): void => {
		const token = tokens[idx];
		if (!token.map) {
			return;
		}
		// markdown-it `map` is [startLine, endLine) zero-based.
		// We expose 1-based, inclusive line numbers so they line up with
		// the editor gutter.
		const startLine = token.map[0] + 1;
		const endLine = token.map[1];
		token.attrJoin('data-source-line', String(startLine));
		token.attrJoin('data-source-line-end', String(endLine));
	};

	// Wrap default renderers for every block-level open token we care about.
	const blockOpenTypes = [
		'paragraph_open',
		'heading_open',
		'bullet_list_open',
		'ordered_list_open',
		'list_item_open',
		'blockquote_open',
		'table_open',
		'hr',
	];

	for (const type of blockOpenTypes) {
		const previous = md.renderer.rules[type];
		md.renderer.rules[type] = (tokens, idx, options, env, self) => {
			injectSourceMap(tokens, idx);
			return previous
				? previous(tokens, idx, options, env, self)
				: self.renderToken(tokens, idx, options);
		};
	}

	// `fence` and `code_block` are leaf tokens — they have a map but no
	// matching `_open`/`_close` pair, so handle them directly.
	for (const type of ['fence', 'code_block'] as const) {
		const previous = md.renderer.rules[type];
		md.renderer.rules[type] = (tokens, idx, options, env, self) => {
			injectSourceMap(tokens, idx);
			return previous
				? previous(tokens, idx, options, env, self)
				: self.renderToken(tokens, idx, options);
		};
	}

	return md;
}

const md = createMarkdownIt();

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let nonce = '';
	for (let i = 0; i < 32; i++) {
		nonce += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return nonce;
}

function buildHtml(
	webview: vscode.Webview,
	extensionUri: vscode.Uri,
	renderedBody: string,
): string {
	const nonce = getNonce();
	const cssUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'media', 'preview.css'),
	);
	const jsUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'media', 'preview.js'),
	);

	const csp = [
		`default-src 'none'`,
		`img-src ${webview.cspSource} data:`,
		`style-src ${webview.cspSource}`,
		`script-src 'nonce-${nonce}'`,
		`font-src ${webview.cspSource}`,
	].join('; ');

	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="${csp}" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link rel="stylesheet" href="${cssUri}" />
	<title>Ask Markdown Preview</title>
</head>
<body>
	<article id="content">${renderedBody}</article>
	<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

/**
 * Open the Ask Markdown preview for the given document.
 *
 * Returns the panel wrapper so callers (e.g. `extension.ts`) can attach
 * a `webview.onDidReceiveMessage` handler.
 */
export function openPreview(
	context: vscode.ExtensionContext,
	document: vscode.TextDocument,
): AskMarkdownPanel {
	const panel = vscode.window.createWebviewPanel(
		VIEW_TYPE,
		`Ask Markdown: ${getDocumentLabel(document)}`,
		{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [
				vscode.Uri.joinPath(context.extensionUri, 'media'),
			],
		},
	);

	const render = (): void => {
		const body = md.render(document.getText());
		panel.webview.html = buildHtml(panel.webview, context.extensionUri, body);
	};

	render();

	const changeSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
		if (e.document.uri.toString() === document.uri.toString()) {
			render();
		}
	});

	const messageSubscription = panel.webview.onDidReceiveMessage(
		async (message: AskAboutSelectionMessage | { type: string }) => {
			if (message.type === 'askAboutSelection') {
				await handleAskAboutSelection(
					document,
					message as AskAboutSelectionMessage,
				);
			}
		},
	);

	panel.onDidDispose(() => {
		changeSubscription.dispose();
		messageSubscription.dispose();
	});

	return { panel, sourceDocument: document };
}

function getDocumentLabel(document: vscode.TextDocument): string {
	const path = document.uri.path;
	const slash = path.lastIndexOf('/');
	return slash >= 0 ? path.slice(slash + 1) : path;
}
