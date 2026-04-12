import * as vscode from 'vscode';
import MarkdownIt from 'markdown-it';
const texmath = require('markdown-it-texmath');
const katex = require('katex');
const hljs = require('highlight.js/lib/common');
import { toRange } from './sourceMapper';
import { broadcast, isConnected, updateLatestSelection } from './claudeServer';

type Token = Parameters<MarkdownIt['renderer']['render']>[0][number];

/**
 * Build a markdown-it instance whose block-level opening tags carry
 * `data-source-line` / `data-source-line-end` attributes derived from
 * `token.map`. The webview reads these to map a DOM selection back to a
 * source line range.
 */
export function createMarkdownIt(): MarkdownIt {
	const md = new MarkdownIt({
		html: true,
		linkify: true,
		breaks: false,
		highlight: (str: string, lang: string): string => {
			if (lang && hljs.getLanguage(lang)) {
				try {
					return hljs.highlight(str, {
						language: lang,
						ignoreIllegals: true,
					}).value;
				} catch {
					// fall through
				}
			}
			return '';
		},
	});

	md.use(texmath, { engine: katex, delimiters: 'dollars' });

	const injectSourceMap = (tokens: Token[], idx: number): void => {
		const token = tokens[idx];
		if (!token.map) {
			return;
		}
		const startLine = token.map[0] + 1;
		const endLine = token.map[1];
		token.attrJoin('data-source-line', String(startLine));
		token.attrJoin('data-source-line-end', String(endLine));
	};

	const sourceMapTypes = [
		'paragraph_open',
		'heading_open',
		'bullet_list_open',
		'ordered_list_open',
		'list_item_open',
		'blockquote_open',
		'table_open',
		'hr',
		'fence',
		'code_block',
	];

	for (const type of sourceMapTypes) {
		const previous = md.renderer.rules[type];
		md.renderer.rules[type] = (tokens, idx, options, env, self) => {
			injectSourceMap(tokens, idx);
			return previous
				? previous(tokens, idx, options, env, self)
				: self.renderToken(tokens, idx, options);
		};
	}

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

async function revealInSourceEditor(
	document: vscode.TextDocument,
	startLine: number,
	endLine: number,
): Promise<void> {
	await vscode.commands.executeCommand(
		'vscode.openWith',
		document.uri,
		'default',
		vscode.ViewColumn.Beside,
	);

	const editor = vscode.window.visibleTextEditors.find(
		(e) => e.document.uri.toString() === document.uri.toString(),
	);
	if (editor) {
		const range = toRange(document, startLine, endLine);
		editor.selection = new vscode.Selection(range.start, range.end);
		editor.revealRange(
			range,
			vscode.TextEditorRevealType.InCenterIfOutsideViewport,
		);
	}
}

export class AskMarkdownEditorProvider implements vscode.CustomTextEditorProvider {
	public static readonly viewType = 'askMarkdown.preview';

	constructor(private readonly context: vscode.ExtensionContext) {}

	public static register(context: vscode.ExtensionContext): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(
			AskMarkdownEditorProvider.viewType,
			new AskMarkdownEditorProvider(context),
			{
				webviewOptions: { retainContextWhenHidden: true },
				supportsMultipleEditorsPerDocument: false,
			},
		);
	}

	public async resolveCustomTextEditor(
		document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken,
	): Promise<void> {
		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.context.extensionUri, 'media'),
				vscode.Uri.joinPath(
					this.context.extensionUri,
					'node_modules',
					'katex',
					'dist',
				),
			],
		};

		const render = (): void => {
			const body = md.render(document.getText());
			webviewPanel.webview.html = buildHtml(
				webviewPanel.webview,
				this.context.extensionUri,
				body,
			);
		};

		render();

		// Send initial settings to the webview.
		const initConfig = vscode.workspace.getConfiguration('ask-markdown');
		webviewPanel.webview.postMessage({
			type: 'updateShowFloatingButton',
			enabled: initConfig.get<boolean>('showFloatingButton', true),
		});
		let updateTimer: ReturnType<typeof setTimeout> | null = null;

		const changeSubscription = vscode.workspace.onDidChangeTextDocument(
			(e) => {
				if (e.document.uri.toString() === document.uri.toString()) {
					if (updateTimer) {
						clearTimeout(updateTimer);
					}
					updateTimer = setTimeout(() => {
						const body = md.render(document.getText());
						webviewPanel.webview.postMessage({
							type: 'updateContent',
							body,
						});
					}, 150);
				}
			},
		);

		let scrollingFromPreview = false;
		let scrollGuardTimer: ReturnType<typeof setTimeout> | null = null;

		const scrollSubscription =
			vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
				if (scrollingFromPreview) {
					return;
				}
				if (
					e.textEditor.document.uri.toString() ===
						document.uri.toString() &&
					e.visibleRanges.length > 0
				) {
					const topLine = e.visibleRanges[0].start.line + 1;
					webviewPanel.webview.postMessage({
						type: 'scrollTo',
						line: topLine,
					});
				}
			});

		const messageSubscription = webviewPanel.webview.onDidReceiveMessage(
			async (message: { type: string; [key: string]: unknown }) => {
				if (message.type === 'toggleSource') {
					// Flip in-place: open the text editor in the same
					// column, then dispose the preview panel so the
					// switch feels like turning a card over.
					const viewColumn =
						webviewPanel.viewColumn ??
						vscode.ViewColumn.Active;
					await vscode.commands.executeCommand(
						'vscode.openWith',
						document.uri,
						'default',
						viewColumn,
					);
					webviewPanel.dispose();
				} else if (message.type === 'revealSource') {
					const startLine = Math.max(0, Number(message.line) - 1);
					const endLine = message.endLine
						? Math.max(0, Number(message.endLine) - 1)
						: startLine;
					await revealInSourceEditor(document, startLine, endLine);
				} else if (message.type === 'askClaude') {
					const startLine = Number(message.startLine);
					const endLine = Number(message.endLine);
					if (!isConnected()) {
						vscode.window.showWarningMessage(
							'Ask Markdown: No Claude CLI connected. Run "claude" in a terminal first.',
						);
						return;
					}
					broadcast('at_mentioned', {
						filePath: document.uri.fsPath,
						lineStart: startLine,
						lineEnd: endLine,
					});
					vscode.commands.executeCommand('workbench.action.terminal.focus');
				} else if (message.type === 'syncSelection') {
					const startLine = Math.max(
						0,
						Number(message.startLine) - 1,
					);
					const endLine = Math.max(0, Number(message.endLine) - 1);
					const range = toRange(document, startLine, endLine);
					const editor = vscode.window.visibleTextEditors.find(
						(e) =>
							e.document.uri.toString() ===
							document.uri.toString(),
					);
					if (editor) {
						editor.selection = new vscode.Selection(
							range.start,
							range.end,
						);
						editor.revealRange(
							range,
							vscode.TextEditorRevealType
								.InCenterIfOutsideViewport,
						);
					}
					const selectedText =
						(message.text as string | undefined) ??
						document.getText(range);
					const selectionPayload = {
						text: selectedText,
						filePath: document.uri.fsPath,
						fileUrl: document.uri.toString(),
						selection: {
							start: {
								line: range.start.line,
								character: range.start.character,
							},
							end: {
								line: range.end.line,
								character: range.end.character,
							},
							isEmpty: false,
						},
					};
					updateLatestSelection(selectionPayload);
					if (isConnected()) {
						broadcast('selection_changed', selectionPayload);
					}
				} else if (message.type === 'previewSelectionCleared') {
					if (isConnected()) {
						broadcast('selection_changed', {
							text: '',
							filePath: document.uri.fsPath,
							fileUrl: document.uri.toString(),
							selection: {
								start: { line: 0, character: 0 },
								end: { line: 0, character: 0 },
								isEmpty: true,
							},
						});
					}
				} else if (message.type === 'scrollFromPreview') {
					const line = Math.max(0, Number(message.line) - 1);
					scrollingFromPreview = true;
					if (scrollGuardTimer) {
						clearTimeout(scrollGuardTimer);
					}
					scrollGuardTimer = setTimeout(() => {
						scrollingFromPreview = false;
					}, 100);
					const editor = vscode.window.visibleTextEditors.find(
						(e) =>
							e.document.uri.toString() ===
							document.uri.toString(),
					);
					if (editor) {
						const pos = new vscode.Position(line, 0);
						editor.revealRange(
							new vscode.Range(pos, pos),
							vscode.TextEditorRevealType.AtTop,
						);
					}
				}
			},
		);

		const configSubscription = vscode.workspace.onDidChangeConfiguration(
			(e) => {
				if (e.affectsConfiguration('ask-markdown.showFloatingButton')) {
					const cfg =
						vscode.workspace.getConfiguration('ask-markdown');
					webviewPanel.webview.postMessage({
						type: 'updateShowFloatingButton',
						enabled: cfg.get<boolean>('showFloatingButton', true),
					});
				}
			},
		);

		webviewPanel.onDidDispose(() => {
			changeSubscription.dispose();
			scrollSubscription.dispose();
			messageSubscription.dispose();
			configSubscription.dispose();
		});
	}
}
