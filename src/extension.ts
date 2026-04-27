import * as vscode from 'vscode';
import { AskMarkdownEditorProvider } from './previewProvider';
import { startServer, stopServer } from './claudeServer';
import {
	readUriFromInput,
	resolveTargetMarkdown,
	tabRefMatches,
} from './markdownTabs';

export function activate(context: vscode.ExtensionContext) {
	console.log('[ask-markdown] activated');

	const diag = vscode.window.createOutputChannel('Ask Markdown');
	context.subscriptions.push(diag);

	startServer(context).then((port) => {
		console.log(`[ask-markdown] Claude server ready on port ${port}`);
	}).catch((err) => {
		console.error('[ask-markdown] Failed to start Claude server:', err);
	});

	context.subscriptions.push(
		AskMarkdownEditorProvider.register(context),

		vscode.commands.registerCommand('ask-markdown.showPreview', async () => {
			const target = await resolveTargetMarkdown(
				AskMarkdownEditorProvider.viewType,
				diag,
			);
			if (!target) {
				vscode.window.showInformationMessage(
					'Ask Markdown: open a markdown file first.',
				);
				return;
			}
			await vscode.commands.executeCommand(
				'vscode.openWith',
				target.uri,
				AskMarkdownEditorProvider.viewType,
			);
			// Re-resolve each captured ref against the live tab state.
			// `openWith` may have replaced a same-URI custom/text tab in
			// place, in which case no live tab matches the ref and we skip
			// it. Also defensively skip any live tab that now points at our
			// own viewType.
			if (target.tabRefs.length > 0) {
				const closable: vscode.Tab[] = [];
				for (const group of vscode.window.tabGroups.all) {
					for (const tab of group.tabs) {
						if (
							tab.input instanceof vscode.TabInputCustom &&
							tab.input.viewType ===
								AskMarkdownEditorProvider.viewType
						) {
							continue;
						}
						if (
							target.tabRefs.some((ref) =>
								tabRefMatches(
									tab,
									ref,
									AskMarkdownEditorProvider.viewType,
								),
							)
						) {
							closable.push(tab);
						}
					}
				}
				if (closable.length > 0) {
					try {
						await vscode.window.tabGroups.close(closable);
					} catch (err) {
						console.warn(
							'[ask-markdown] Failed to close original tabs:',
							err,
						);
					}
				}
			}
		}),

		// Flip a text editor back to the Ask Markdown preview in-place.
		// Shown as "</>" in the editor title bar so the user can flip
		// back and forth between rendered preview and source.
		vscode.commands.registerCommand('ask-markdown.flipToPreview', async () => {
			let uri: vscode.Uri | undefined;
			let viewColumn = vscode.ViewColumn.Active;

			// Try the active text editor first (plain source editing).
			const editor = vscode.window.activeTextEditor;
			if (editor?.document.languageId === 'markdown') {
				uri = editor.document.uri;
				viewColumn = editor.viewColumn ?? vscode.ViewColumn.Active;
			} else {
				// Fallback: read the URI from the active tab's input.
				// Covers Cursor's built-in markdown editor which may
				// not expose an activeTextEditor.
				const activeTab =
					vscode.window.tabGroups.activeTabGroup.activeTab;
				if (activeTab) {
					const info = readUriFromInput(activeTab.input);
					if (info?.uri.path.toLowerCase().endsWith('.md')) {
						// Don't flip if we're already in our own preview.
						if (
							info.viewType ===
							AskMarkdownEditorProvider.viewType
						) {
							return;
						}
						uri = info.uri;
					}
				}
			}

			if (!uri) {
				return;
			}

			// Locate the current tab before opening the preview — the
			// tab list may change once the custom editor activates.
			const currentTab = vscode.window.tabGroups.all
				.flatMap((g) => g.tabs)
				.find((t) => {
					if (t.input instanceof vscode.TabInputText) {
						return (
							t.input.uri.toString() === uri!.toString()
						);
					}
					const info = readUriFromInput(t.input);
					if (!info) {
						return false;
					}
					if (
						info.viewType ===
						AskMarkdownEditorProvider.viewType
					) {
						return false;
					}
					return info.uri.toString() === uri!.toString();
				});

			await vscode.commands.executeCommand(
				'vscode.openWith',
				uri,
				AskMarkdownEditorProvider.viewType,
				viewColumn,
			);

			if (currentTab) {
				try {
					await vscode.window.tabGroups.close(currentTab);
				} catch {
					// Tab may already have been replaced
				}
			}
		}),
	);

	// When defaultEditor is enabled, auto-open .md files in our preview.
	const openIfDefault = (editor: vscode.TextEditor | undefined): void => {
		if (!editor) {
			return;
		}
		const config = vscode.workspace.getConfiguration('ask-markdown');
		if (!config.get<boolean>('defaultEditor', false)) {
			return;
		}
		if (editor.document.languageId !== 'markdown') {
			return;
		}
		// Only redirect if it's a regular text editor (not already our custom editor).
		const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
		if (tab?.input instanceof vscode.TabInputText) {
			vscode.commands.executeCommand(
				'vscode.openWith',
				editor.document.uri,
				AskMarkdownEditorProvider.viewType,
			);
		}
	};

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor((editor) => {
			openIfDefault(editor);
		}),
	);

	// Also check the current editor on activation.
	openIfDefault(vscode.window.activeTextEditor);
}

export function deactivate() {
	stopServer();
}
