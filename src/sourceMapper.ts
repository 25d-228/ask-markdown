import * as vscode from 'vscode';

/**
 * Convert a zero-based line range into a `vscode.Range` that covers the
 * full text of those lines, clamped to the document bounds.
 *
 * - `startLine` and `endLine` are zero-based and inclusive.
 * - Out-of-range values are clamped to `[0, doc.lineCount - 1]`.
 * - If `endLine < startLine` after clamping, they are swapped.
 * - The end position uses the end-of-line column so the entire last line
 *   is included in the selection.
 */
export function toRange(
	doc: vscode.TextDocument,
	startLine: number,
	endLine: number,
): vscode.Range {
	const lastLine = Math.max(0, doc.lineCount - 1);

	let start = clamp(Math.floor(startLine), 0, lastLine);
	let end = clamp(Math.floor(endLine), 0, lastLine);

	if (end < start) {
		[start, end] = [end, start];
	}

	const startPos = new vscode.Position(start, 0);
	const endLineLength = doc.lineAt(end).text.length;
	const endPos = new vscode.Position(end, endLineLength);

	return new vscode.Range(startPos, endPos);
}

function clamp(value: number, min: number, max: number): number {
	if (Number.isNaN(value)) {
		return min;
	}
	if (value < min) {
		return min;
	}
	if (value > max) {
		return max;
	}
	return value;
}
