import * as vscode from 'vscode';
import * as path from 'path';

function getRelativePath(filePath: string): string {
	const folders = vscode.workspace.workspaceFolders;
	if (folders) {
		for (const folder of folders) {
			const root = folder.uri.fsPath;
			if (filePath.startsWith(root)) {
				return path.relative(root, filePath);
			}
		}
	}
	return filePath;
}

async function pickOrCreateTerminal(): Promise<vscode.Terminal | 'created' | undefined> {
	const allTerminals = vscode.window.terminals;

	if (allTerminals.length === 0) {
		const terminal = vscode.window.createTerminal();
		terminal.sendText('codex', true);
		terminal.show(true);
		return 'created';
	}

	if (allTerminals.length === 1) {
		return allTerminals[0];
	}

	const items = allTerminals.map((t) => ({
		label: t.name,
		terminal: t,
	}));
	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: 'Pick a terminal to send to',
	});
	return picked?.terminal;
}

export async function sendToCodex(
	filePath: string,
	startLine: number,
	endLine: number,
): Promise<void> {
	const result = await pickOrCreateTerminal();
	if (!result) {
		return;
	}

	const relativePath = getRelativePath(filePath);
	const mention =
		startLine === endLine
			? `@${relativePath}:${startLine}`
			: `@${relativePath}:${startLine}-${endLine}`;

	if (result === 'created') {
		await vscode.env.clipboard.writeText(mention + ' ');
		vscode.window.showInformationMessage(
			`Ask Markdown: Codex is launching. The mention has been copied to your clipboard — paste it once Codex is ready.`,
		);
		return;
	}

	result.sendText(mention + ' ', false);
	result.show(true);
}
