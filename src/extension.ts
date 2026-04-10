import * as vscode from 'vscode';
import { openPreview } from './previewProvider';

export function activate(context: vscode.ExtensionContext) {
	console.log('[ask-markdown] activated');

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

export function deactivate() {}
