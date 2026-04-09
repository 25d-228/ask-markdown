import * as vscode from 'vscode';
import MarkdownIt from 'markdown-it';
const texmath = require('markdown-it-texmath');
const katex = require('katex');
import {
	handleAskAboutSelection,
	type AskAboutSelectionMessage,
} from './selectionBridge';
import { toRange } from './sourceMapper';

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

/** Track which documents already have a preview open. */
const openPreviews = new Map<string, vscode.WebviewPanel>();

/** Documents whose preview was manually closed — don't auto-reopen. */
const dismissedPreviews = new Set<string>();

export function hasPreview(document: vscode.TextDocument): boolean {
	return openPreviews.has(document.uri.toString());
}

export function wasDismissed(document: vscode.TextDocument): boolean {
	return dismissedPreviews.has(document.uri.toString());
}

export function clearDismissed(uri: string): void {
	dismissedPreviews.delete(uri);
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

	md.use(texmath, { engine: katex, delimiters: 'dollars' });

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

	// texmath's math_block renderer emits its own HTML (<section><eqn>...),
	// ignoring token attributes. Wrap the output in a <div> carrying the
	// source-line data attributes instead.
	{
		const previous = md.renderer.rules['math_block'];
		md.renderer.rules['math_block'] = (tokens, idx, options, env, self) => {
			const token = tokens[idx];
			const inner = previous
				? previous(tokens, idx, options, env, self)
				: self.renderToken(tokens, idx, options);
			if (!token.map) {
				return inner;
			}
			const startLine = token.map[0] + 1;
			const endLine = token.map[1];
			return `<div data-source-line="${startLine}" data-source-line-end="${endLine}">${inner}</div>`;
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
	const katexCssUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'node_modules', 'katex', 'dist', 'katex.min.css'),
	);
	const jsUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'media', 'preview.js'),
	);

	const csp = [
		`default-src 'none'`,
		`img-src ${webview.cspSource} data:`,
		`style-src ${webview.cspSource} 'unsafe-inline'`,
		`script-src 'nonce-${nonce}'`,
		`font-src ${webview.cspSource}`,
	].join('; ');

	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="${csp}" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link rel="stylesheet" href="${katexCssUri}" />
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
	// If a preview already exists for this document, just reveal it.
	const key = document.uri.toString();
	const existing = openPreviews.get(key);
	if (existing) {
		existing.reveal();
		return { panel: existing, sourceDocument: document };
	}

	const panel = vscode.window.createWebviewPanel(
		VIEW_TYPE,
		`Ask Markdown: ${getDocumentLabel(document)}`,
		{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [
				vscode.Uri.joinPath(context.extensionUri, 'media'),
				vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'katex', 'dist'),
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
		async (message: AskAboutSelectionMessage | { type: string; [key: string]: unknown }) => {
			if (message.type === 'askAboutSelection') {
				await handleAskAboutSelection(
					document,
					message as AskAboutSelectionMessage,
				);
			} else if (message.type === 'revealSource') {
				const startLine = Math.max(0, Number(message.line) - 1);
				const endLine = message.endLine
					? Math.max(0, Number(message.endLine) - 1)
					: startLine;
				const range = toRange(document, startLine, endLine);
				const editor = await vscode.window.showTextDocument(document, {
					viewColumn: vscode.ViewColumn.One,
					preserveFocus: false,
				});
				editor.selection = new vscode.Selection(range.start, range.end);
				editor.revealRange(
					range,
					vscode.TextEditorRevealType.InCenterIfOutsideViewport,
				);
			} else if (message.type === 'syncSelection') {
				const startLine = Math.max(0, Number(message.startLine) - 1);
				const endLine = Math.max(0, Number(message.endLine) - 1);
				const range = toRange(document, startLine, endLine);
				const editor = vscode.window.visibleTextEditors.find(
					(e) => e.document.uri.toString() === document.uri.toString(),
				);
				if (editor) {
					editor.selection = new vscode.Selection(range.start, range.end);
					editor.revealRange(
						range,
						vscode.TextEditorRevealType.InCenterIfOutsideViewport,
					);
				}
			} else if (message.type === 'copyText') {
				await vscode.env.clipboard.writeText(String(message.text));
			}
		},
	);

	// Scroll sync: editor visible range → webview
	const scrollSubscription = vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
		if (
			e.textEditor.document.uri.toString() === document.uri.toString() &&
			e.visibleRanges.length > 0
		) {
			const topLine = e.visibleRanges[0].start.line + 1; // 0-based → 1-based
			panel.webview.postMessage({ type: 'scrollTo', line: topLine });
		}
	});

	openPreviews.set(key, panel);

	// Set editor layout to 1:3 ratio (source : preview).
	vscode.commands.executeCommand('vscode.setEditorLayout', {
		orientation: 0,
		groups: [{ size: 0.25 }, { size: 0.75 }],
	});

	panel.onDidDispose(() => {
		openPreviews.delete(key);
		dismissedPreviews.add(key);
		changeSubscription.dispose();
		messageSubscription.dispose();
		scrollSubscription.dispose();
	});

	return { panel, sourceDocument: document };
}

function getDocumentLabel(document: vscode.TextDocument): string {
	const path = document.uri.path;
	const slash = path.lastIndexOf('/');
	return slash >= 0 ? path.slice(slash + 1) : path;
}
