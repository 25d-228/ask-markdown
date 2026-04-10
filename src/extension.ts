import * as vscode from 'vscode';
import { AskMarkdownEditorProvider } from './previewProvider';
import { startServer, stopServer } from './claudeServer';

export function activate(context: vscode.ExtensionContext) {
	console.log('[ask-markdown] activated');

	startServer().then((port) => {
		console.log(`[ask-markdown] Claude server ready on port ${port}`);
	}).catch((err) => {
		console.error('[ask-markdown] Failed to start Claude server:', err);
	});

	context.subscriptions.push(
		AskMarkdownEditorProvider.register(context),

		vscode.commands.registerCommand('ask-markdown.showPreview', () => {
			const uri = vscode.window.activeTextEditor?.document.uri;
			if (uri) {
				vscode.commands.executeCommand(
					'vscode.openWith',
					uri,
					AskMarkdownEditorProvider.viewType,
				);
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
		vscode.window.onDidChangeActiveTextEditor(openIfDefault),
	);

	// Also check the current editor on activation.
	openIfDefault(vscode.window.activeTextEditor);
}

export function deactivate() {
	stopServer();
}
