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
}

export function deactivate() {
	stopServer();
}
