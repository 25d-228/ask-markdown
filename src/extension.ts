import * as vscode from 'vscode';
import { openPreview, hasPreview, wasDismissed, clearDismissed } from './previewProvider';

export function activate(context: vscode.ExtensionContext) {
	console.log('[ask-markdown] activated');

	function tryAutoOpen(document: vscode.TextDocument): void {
		const auto = vscode.workspace
			.getConfiguration('ask-markdown')
			.get<boolean>('autoOpen');
		if (auto && document.languageId === 'markdown' && !hasPreview(document) && !wasDismissed(document)) {
			openPreview(context, document);
		}
	}

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
		vscode.commands.registerCommand('ask-markdown.askAboutSelection', () => {
			vscode.window.showInformationMessage(
				'Ask Markdown: Ask About Selection (not implemented yet)',
			);
		}),
		vscode.window.onDidChangeActiveTextEditor((editor) => {
			if (editor) {
				tryAutoOpen(editor.document);
			}
		}),
		// When a document is closed, forget that its preview was dismissed
		// so reopening the file will auto-open the preview again.
		vscode.workspace.onDidCloseTextDocument((doc) => {
			clearDismissed(doc.uri.toString());
		}),
	);

	// Auto-open for the already-active editor on activation.
	if (vscode.window.activeTextEditor) {
		tryAutoOpen(vscode.window.activeTextEditor.document);
	}
}

export function deactivate() {}
