import * as vscode from 'vscode';
import { toRange } from './sourceMapper';
import { broadcast, isConnected, updateLatestSelection } from './agents/mcp/server';
import { createMarkdownIt } from './markdownRenderer';
import { buildPreviewHtml } from './preview/html';
import { exportPdf } from './preview/pdfExport';
import { TranslateRunner } from './preview/translate';
import { InlineEditRunner } from './preview/inlineEdit';

// Re-exported so existing importers of `createMarkdownIt` from this module
// keep working (notably the renderRule test suite).
export { createMarkdownIt };

const md = createMarkdownIt();

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
			const source = document.getText();
			const body = md.render(source, { source });
			webviewPanel.webview.html = buildPreviewHtml(
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
			type: 'updateTranslateEnabled',
			enabled: initConfig.get<boolean>('translateEnabled', true),
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
						const body = md.render(text, { source: text });
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
		const inlineEdit = new InlineEditRunner();
		const translate = new TranslateRunner();
		const post = (msg: { type: string; [key: string]: unknown }): void => {
			webviewPanel.webview.postMessage(msg);
		};

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
					// The webview reports 1-based inclusive lines, but Claude
					// Code expects 0-based LSP-style positions (matching the
					// selection_changed payload we already emit via
					// syncSelection). Convert before broadcasting so the
					// @-mention Claude renders matches the selected range.
					const startLine = Math.max(
						0,
						Number(message.startLine) - 1,
					);
					const endLine = Math.max(0, Number(message.endLine) - 1);
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
					const startLine = Number(message.startLine);
					const endLine = Number(message.endLine);
					const selectedText = message.text as string;
					const instruction =
						typeof message.instruction === 'string'
							? message.instruction.trim()
							: '';
					inlineEdit.start({
						document,
						startLine,
						endLine,
						selectedText,
						instruction,
						post,
					});
				} else if (message.type === 'inlineEditCancel') {
					inlineEdit.cancel();
				} else if (message.type === 'translate') {
					const selectedText = (message.text as string) || '';
					translate.start(selectedText, post);
				} else if (message.type === 'translateCancel') {
					translate.cancel();
				} else if (message.type === 'openLink') {
					const href =
						typeof message.href === 'string' ? message.href : '';
					if (!href) {
						return;
					}
					let target: vscode.Uri | undefined;
					try {
						target = vscode.Uri.parse(href, true);
					} catch {
						target = undefined;
					}
					if (!target || !target.scheme) {
						// Relative path — resolve against the document's directory.
						const docDir = vscode.Uri.joinPath(document.uri, '..');
						target = vscode.Uri.joinPath(docDir, href);
					}
					if (
						target.scheme === 'file' &&
						target.path.toLowerCase().endsWith('.md')
					) {
						await vscode.commands.executeCommand(
							'vscode.openWith',
							target,
							AskMarkdownEditorProvider.viewType,
						);
					} else {
						await vscode.env.openExternal(target);
					}
				} else if (message.type === 'exportPdf') {
					const style =
						typeof message.style === 'string' ? message.style : 'clean';
					await exportPdf(
						document,
						style,
						this.context.extensionPath,
						(source) => md.render(source, { source }),
					);
				}
			},
		);

		const configSubscription = vscode.workspace.onDidChangeConfiguration(
			(e) => {
				const cfg = vscode.workspace.getConfiguration('ask-markdown');
				if (e.affectsConfiguration('ask-markdown.showFloatingButton')) {
					webviewPanel.webview.postMessage({
						type: 'updateShowFloatingButton',
						enabled: cfg.get<boolean>('showFloatingButton', true),
					});
				}
				if (e.affectsConfiguration('ask-markdown.translateEnabled')) {
					webviewPanel.webview.postMessage({
						type: 'updateTranslateEnabled',
						enabled: cfg.get<boolean>('translateEnabled', true),
					});
				}
			},
		);

		webviewPanel.onDidDispose(() => {
			changeSubscription.dispose();
			scrollSubscription.dispose();
			messageSubscription.dispose();
			configSubscription.dispose();
			inlineEdit.dispose();
			translate.dispose();
		});
	}
}
