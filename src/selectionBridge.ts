import * as vscode from 'vscode';
import { toRange } from './sourceMapper';

export interface AskAboutSelectionMessage {
	type: 'askAboutSelection';
	text: string;
	startLine: number;
	endLine: number;
}

/**
 * Receive an `askAboutSelection` message from the preview webview and
 * turn it into a real editor selection on the source markdown document.
 *
 * Steps:
 * 1. Convert the 1-based inclusive line range from the webview into a
 *    zero-based `vscode.Range` (clamped to the document bounds).
 * 2. Show the source document in the editor column.
 * 3. Set its selection to the computed range and reveal it.
 * 4. (Phase 5) trigger the configured Cursor "ask" command. For now this
 *    is a no-op so the bridge can be verified independently.
 */
export async function handleAskAboutSelection(
	doc: vscode.TextDocument,
	message: AskAboutSelectionMessage,
): Promise<void> {
	// markdown-it line numbers are 1-based; vscode.Position is 0-based.
	const range = toRange(doc, message.startLine - 1, message.endLine - 1);

	const editor = await vscode.window.showTextDocument(doc, {
		viewColumn: vscode.ViewColumn.One,
		preserveFocus: false,
	});

	editor.selection = new vscode.Selection(range.start, range.end);
	editor.revealRange(
		range,
		vscode.TextEditorRevealType.InCenterIfOutsideViewport,
	);

	// Phase 5 will read `ask-markdown.askCommandId` from settings and
	// invoke it here via vscode.commands.executeCommand(...).
}
