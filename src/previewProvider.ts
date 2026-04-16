import * as vscode from 'vscode';
import MarkdownIt from 'markdown-it';
const texmath = require('markdown-it-texmath');
const katex = require('katex');
const hljs = require('highlight.js/lib/common');
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
	<div id="app">
		<div id="toolbar">
			<button id="edit-btn" title="Open in external editor">Edit</button>
			<button id="toggle-source" title="Show Source">&lt;/&gt;</button>
		</div>
		<div id="view-container">
			<div id="content-scroll">
				<article id="content">${renderedBody}</article>
			</div>
			<div id="source-view" style="display:none">
				<div id="line-numbers" aria-hidden="true"></div>
				<div id="source-highlight" aria-hidden="true"></div>
				<textarea id="source-editor" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off"></textarea>
			</div>
		</div>
	</div>
	<div id="ask-bar">
		<button data-action="claude">Add</button>
		<span class="ask-bar-sep"></span>
		<button data-action="edit">Inline Edit</button>
		<span class="ask-bar-sep"></span>
		<button data-action="translate">Translate</button>
		<span class="ask-bar-sep"></span>
		<button data-action="find">Find in source</button>
	</div>
	<div id="edit-bar">
		<input id="edit-input" type="text" placeholder='e.g. "make this a numbered list"' autocomplete="off" spellcheck="false" />
		<button id="edit-submit" type="button" title="Submit (Enter)">Edit</button>
		<button id="edit-cancel" type="button" title="Cancel (Esc)">&times;</button>
		<div id="edit-status" aria-live="polite">
			<span class="edit-thinking">
				<span class="edit-square"></span>
				<span class="edit-square"></span>
				<span class="edit-square"></span>
			</span>
			<span class="edit-status-text">Thinking\u2026</span>
		</div>
	</div>
	<div id="translate-bar">
		<div id="translate-header">
			<span class="translate-title">Translation <span id="translate-lang"></span></span>
			<button id="translate-close" type="button" title="Close (Esc)">&times;</button>
		</div>
		<div id="translate-status" aria-live="polite">
			<span class="edit-thinking">
				<span class="edit-square"></span>
				<span class="edit-square"></span>
				<span class="edit-square"></span>
			</span>
			<span class="translate-status-text">Thinking\u2026</span>
		</div>
		<div id="translate-content" aria-live="polite"></div>
	</div>
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
		webviewPanel.webview.postMessage({
			type: 'updateSource',
			text: document.getText(),
		});
		let updateTimer: ReturnType<typeof setTimeout> | null = null;

		const changeSubscription = vscode.workspace.onDidChangeTextDocument(
			(e) => {
				if (e.document.uri.toString() === document.uri.toString()) {
					if (updateTimer) {
						clearTimeout(updateTimer);
					}
					updateTimer = setTimeout(() => {
						const text = document.getText();
						const body = md.render(text);
						webviewPanel.webview.postMessage({
							type: 'updateContent',
							body,
						});
						webviewPanel.webview.postMessage({
							type: 'updateSource',
							text,
						});
					}, 150);
				}
			},
		);

		let scrollingFromPreview = false;
		let scrollGuardTimer: ReturnType<typeof setTimeout> | null = null;
		let inlineEditProc: ReturnType<typeof spawn> | null = null;
		let translateProc: ReturnType<typeof spawn> | null = null;

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
				if (message.type === 'revealSource') {
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
				} else if (message.type === 'editSource') {
					const newText = message.text as string;
					const fullRange = new vscode.Range(
						document.positionAt(0),
						document.positionAt(document.getText().length),
					);
					const edit = new vscode.WorkspaceEdit();
					edit.replace(document.uri, fullRange, newText);
					await vscode.workspace.applyEdit(edit);
				} else if (message.type === 'inlineEdit') {
					if (inlineEditProc) {
						inlineEditProc.kill();
						inlineEditProc = null;
					}

					const startLine = Number(message.startLine);
					const endLine = Number(message.endLine);
					const selectedText = message.text as string;
					const instruction =
						typeof message.instruction === 'string'
							? message.instruction.trim()
							: '';

					if (!instruction) {
						webviewPanel.webview.postMessage({
							type: 'inlineEditError',
							error: 'Empty instruction',
						});
						return;
					}

					// Write the current in-memory document content to a
					// scratch file we own. Claude edits that copy; we apply
					// the result back to the real document via WorkspaceEdit
					// so the change goes through VS Code's normal text edit
					// pipeline (undo-able, no file watcher dependency, works
					// even when the document has unsaved changes).
					const baseName = path.basename(document.uri.fsPath) || 'doc.md';
					const safeBase = baseName.replace(/[^a-zA-Z0-9._-]/g, '_');
					const tempPath = path.join(
						os.tmpdir(),
						`ask-markdown-edit-${Date.now()}-${safeBase}`,
					);
					try {
						fs.writeFileSync(tempPath, document.getText(), 'utf8');
					} catch (err) {
						webviewPanel.webview.postMessage({
							type: 'inlineEditError',
							error: `Failed to create scratch file: ${(err as Error).message}`,
						});
						return;
					}

					const cleanup = (): void => {
						try {
							fs.unlinkSync(tempPath);
						} catch {
							// Already gone.
						}
					};

					const prompt =
						`File to edit: ${tempPath}\n` +
						`Lines ${startLine}-${endLine} (1-based, inclusive) currently contain:\n\n` +
						`${selectedText}\n\n` +
						`User instruction: ${instruction}\n\n` +
						'Use your Edit tool to apply the instruction to the selected lines in the file. ' +
						'Read the file first if you need surrounding context to make the old_string unique. ' +
						'Output nothing — just edit the file and exit.';

					const proc = spawn(
						'claude',
						[
							'-p',
							'--output-format', 'text',
							'--model', 'sonnet',
							'--allowedTools', 'Read,Edit',
						],
						{ stdio: ['pipe', 'pipe', 'pipe'] },
					);
					inlineEditProc = proc;

					const errChunks: Buffer[] = [];

					proc.stdout!.on('data', () => {
						// Discard claude's chatter; the result is on disk.
					});
					proc.stderr!.on('data', (data: Buffer) => {
						errChunks.push(data);
					});

					proc.on('close', async (code, signal) => {
						if (inlineEditProc !== proc) {
							return;
						}
						inlineEditProc = null;
						if (signal === 'SIGTERM' || signal === 'SIGKILL') {
							cleanup();
							webviewPanel.webview.postMessage({
								type: 'inlineEditDone',
							});
							return;
						}
						if (code !== 0) {
							const stderr = Buffer.concat(errChunks)
								.toString()
								.trim();
							cleanup();
							webviewPanel.webview.postMessage({
								type: 'inlineEditError',
								error: `Claude exited with code ${code}${stderr ? ': ' + stderr : ''}`,
							});
							return;
						}
						try {
							const newContent = fs.readFileSync(tempPath, 'utf8');
							if (newContent !== document.getText()) {
								const fullRange = new vscode.Range(
									document.positionAt(0),
									document.positionAt(document.getText().length),
								);
								const edit = new vscode.WorkspaceEdit();
								edit.replace(document.uri, fullRange, newContent);
								await vscode.workspace.applyEdit(edit);
							}
							webviewPanel.webview.postMessage({
								type: 'inlineEditDone',
							});
						} catch (err) {
							webviewPanel.webview.postMessage({
								type: 'inlineEditError',
								error: `Failed to apply edit: ${(err as Error).message}`,
							});
						} finally {
							cleanup();
						}
					});

					proc.on('error', (err) => {
						if (inlineEditProc !== proc) {
							return;
						}
						inlineEditProc = null;
						cleanup();
						webviewPanel.webview.postMessage({
							type: 'inlineEditError',
							error: `Failed to run claude: ${err.message}`,
						});
					});

					proc.stdin!.write(prompt);
					proc.stdin!.end();
				} else if (message.type === 'inlineEditCancel') {
					if (inlineEditProc) {
						inlineEditProc.kill();
						inlineEditProc = null;
					}
				} else if (message.type === 'translate') {
					if (translateProc) {
						translateProc.kill();
						translateProc = null;
					}

					const selectedText = message.text as string;
					const language = vscode.workspace
						.getConfiguration('ask-markdown')
						.get<string>('outputLanguage', 'en')
						.trim() || 'en';

					const prompt =
						'For the text below, output exactly two parts on separate lines:\n' +
						'1. First line: IPA pronunciation in US English style (e.g. /trænzˈleɪʃən/). For non-English text, give a phonetic IPA approximation. For long selections, give the IPA of the most prominent word/phrase only.\n' +
						`2. Following lines: literal translation/explanation in ${language} (ISO language code), focusing on natural-language meaning (not code or syntax).\n` +
						'No preamble, no labels, no quotes — just the IPA line, then the translation. Do NOT try to read any files; everything you need is below.\n\n' +
						`Text:\n${selectedText}\n`;

					const proc = spawn(
						'claude',
						[
							'-p',
							'--output-format', 'text',
							'--model', 'haiku',
							'--allowedTools', '',
						],
						{ stdio: ['pipe', 'pipe', 'pipe'] },
					);
					translateProc = proc;

					let accumulated = '';
					const errChunks: Buffer[] = [];

					proc.stdout!.on('data', (data: Buffer) => {
						accumulated += data.toString();
						webviewPanel.webview.postMessage({
							type: 'translateResult',
							result: accumulated,
							language,
							streaming: true,
						});
					});
					proc.stderr!.on('data', (data: Buffer) => {
						errChunks.push(data);
					});

					proc.on('close', (code, signal) => {
						if (translateProc !== proc) {
							return;
						}
						translateProc = null;
						if (signal === 'SIGTERM' || signal === 'SIGKILL') {
							return;
						}
						if (code !== 0) {
							const stderr = Buffer.concat(errChunks)
								.toString()
								.trim();
							webviewPanel.webview.postMessage({
								type: 'translateError',
								error: `Claude exited with code ${code}${stderr ? ': ' + stderr : ''}`,
							});
							return;
						}
						webviewPanel.webview.postMessage({
							type: 'translateResult',
							result: accumulated.trim(),
							language,
							streaming: false,
						});
					});

					proc.on('error', (err) => {
						if (translateProc !== proc) {
							return;
						}
						translateProc = null;
						webviewPanel.webview.postMessage({
							type: 'translateError',
							error: `Failed to run claude: ${err.message}`,
						});
					});

					proc.stdin!.write(prompt);
					proc.stdin!.end();
				} else if (message.type === 'translateCancel') {
					if (translateProc) {
						translateProc.kill();
						translateProc = null;
					}
				} else if (message.type === 'openExternalEditor') {
					const viewColumn =
						webviewPanel.viewColumn ??
						vscode.ViewColumn.Active;
					let opened = false;
					try {
						await vscode.commands.executeCommand(
							'vscode.openWith',
							document.uri,
							'vscode.markdown.preview.editor',
							viewColumn,
						);
						opened = true;
					} catch {
						// Markdown editor not available
					}
					if (!opened) {
						await vscode.commands.executeCommand(
							'vscode.openWith',
							document.uri,
							'default',
							viewColumn,
						);
					}
					try {
						webviewPanel.dispose();
					} catch {
						// Already disposed by editor replacement
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
			if (inlineEditProc) {
				inlineEditProc.kill();
				inlineEditProc = null;
			}
			if (translateProc) {
				translateProc.kill();
				translateProc = null;
			}
		});
	}
}
