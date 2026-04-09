import * as vscode from 'vscode';
import { toRange } from './sourceMapper';

export interface AskAboutSelectionMessage {
	type: 'askAboutSelection';
	text: string;
	startLine: number;
	endLine: number;
}

/**
 * Handle an "Ask" action from the preview webview.
 *
 * Since the source editor is visible beside the preview, we can set the
 * selection directly on it — no tab switching, no flicker.
 */
export async function handleAskAboutSelection(
	doc: vscode.TextDocument,
	message: AskAboutSelectionMessage,
): Promise<void> {
	const range = toRange(doc, message.startLine - 1, message.endLine - 1);

	// The source editor is already visible in column 1. Find it directly.
	let editor = vscode.window.visibleTextEditors.find(
		(e) => e.document.uri.toString() === doc.uri.toString(),
	);

	if (!editor) {
		// Fallback: open it beside the preview if somehow not visible.
		editor = await vscode.window.showTextDocument(doc, {
			viewColumn: vscode.ViewColumn.One,
			preserveFocus: true,
		});
	}

	editor.selection = new vscode.Selection(range.start, range.end);
	editor.revealRange(
		range,
		vscode.TextEditorRevealType.InCenterIfOutsideViewport,
	);

	const commandId = vscode.workspace
		.getConfiguration('ask-markdown')
		.get<string>('askCommandId');

	if (commandId) {
		await vscode.commands.executeCommand(commandId);
	}
}
