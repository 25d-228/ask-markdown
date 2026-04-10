import * as vscode from 'vscode';
import { openPreview } from './previewProvider';
import { startServer, stopServer } from './claudeServer';

export function activate(context: vscode.ExtensionContext) {
	console.log('[ask-markdown] activated');

	startServer().then((port) => {
		console.log(`[ask-markdown] Claude server ready on port ${port}`);
	}).catch((err) => {
		console.error('[ask-markdown] Failed to start Claude server:', err);
	});

	context.subscriptions.push(
		vscode.commands.registerCommand('ask-markdown.openPreview', () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.document.languageId !== 'markdown') {
				vscode.window.showWarningMessage(
					'Ask Markdown: open a markdown file first.',
				);
				return;
			}

			openPreview(context, editor.document);
		}),
	);
}

export function deactivate() {
	stopServer();
}
