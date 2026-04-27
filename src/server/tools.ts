import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	disposeAllRenderedDiffs,
	disposeRenderedDiffByTabName,
	openRenderedMarkdownDiff,
} from './renderedDiff';

const MARKDOWN_VIEW_TYPE = 'askMarkdown.preview';

export const toolDefinitions = {
	tools: [
		{
			name: 'getCurrentSelection',
			description: 'Get the current text selection in the active editor',
			inputSchema: {
				type: 'object',
				properties: {},
			},
		},
		{
			name: 'getLatestSelection',
			description:
				'Get the most recently non-empty text selection. Use this to retrieve what the user last selected, even if focus has since moved elsewhere (e.g. to the terminal).',
			inputSchema: {
				type: 'object',
				properties: {},
			},
		},
		{
			name: 'getDiagnostics',
			description:
				'Get language diagnostics from the editor. Returns an empty list for markdown.',
			inputSchema: {
				type: 'object',
				properties: {
					uri: {
						type: 'string',
						description:
							'Optional file URI to filter diagnostics. If omitted, all diagnostics are returned.',
					},
				},
			},
		},
		{
			name: 'getOpenEditors',
			description: 'Get a list of open editor tabs',
			inputSchema: {
				type: 'object',
				properties: {},
			},
		},
		{
			name: 'getWorkspaceFolders',
			description: 'Get workspace folder paths',
			inputSchema: {
				type: 'object',
				properties: {},
			},
		},
		{
			name: 'openFile',
			description:
				'Open a file in the editor. Markdown files open in the Ask Markdown rendered preview.',
			inputSchema: {
				type: 'object',
				properties: {
					filePath: {
						type: 'string',
						description: 'Absolute path to the file to open.',
					},
					startText: {
						type: 'string',
						description:
							'If provided, select starting at the first match of this text.',
					},
					endText: {
						type: 'string',
						description:
							'If provided, extend the selection to the end of the first match of this text after startText.',
					},
					makeFrontmost: {
						type: 'boolean',
						description:
							'Focus the opened tab (default: true).',
					},
				},
				required: ['filePath'],
			},
		},
		{
			name: 'openDiff',
			description:
				'Open a diff view between an existing file and proposed new contents. Blocks until the user saves (accept) or closes (reject) the diff.',
			inputSchema: {
				type: 'object',
				properties: {
					old_file_path: {
						type: 'string',
						description:
							'Absolute path to the existing file.',
					},
					new_file_path: {
						type: 'string',
						description:
							'Path the new contents should be written to (usually the same as old_file_path).',
					},
					new_file_contents: {
						type: 'string',
						description: 'Proposed new file contents.',
					},
					tab_name: {
						type: 'string',
						description: 'Title shown on the diff tab.',
					},
				},
				required: ['old_file_path', 'new_file_contents'],
			},
		},
		{
			name: 'close_tab',
			description: 'Close a tab by its label (title shown on the tab).',
			inputSchema: {
				type: 'object',
				properties: {
					tab_name: {
						type: 'string',
						description: 'Label of the tab to close.',
					},
				},
				required: ['tab_name'],
			},
		},
		{
			name: 'closeAllDiffTabs',
			description: 'Close every open diff tab.',
			inputSchema: {
				type: 'object',
				properties: {},
			},
		},
	],
};

function isDiffTab(tab: vscode.Tab): boolean {
	const input = tab.input as
		| {
				original?: vscode.Uri;
				modified?: vscode.Uri;
				viewType?: string;
		  }
		| undefined;
	if (input?.original && input?.modified) {
		return true;
	}
	// Treat our rendered-diff webview as a diff tab so Claude Code's
	// close_tab / closeAllDiffTabs calls dismiss it after the CLI decision.
	return (
		typeof input?.viewType === 'string' &&
		input.viewType.endsWith('askMarkdown.renderedDiff')
	);
}

function sanitizeBasename(name: string): string {
	return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export async function handleOpenFile(
	args: Record<string, unknown> | undefined,
): Promise<unknown> {
	const filePath = args?.filePath as string | undefined;
	if (!filePath) {
		return {
			content: [
				{
					type: 'text',
					text: 'Error: filePath is required',
				},
			],
			isError: true,
		};
	}

	const uri = vscode.Uri.file(filePath);
	const isMarkdown = /\.mdx?$/i.test(filePath);
	const makeFrontmost = args?.makeFrontmost !== false;

	try {
		if (isMarkdown) {
			await vscode.commands.executeCommand(
				'vscode.openWith',
				uri,
				MARKDOWN_VIEW_TYPE,
				makeFrontmost ? undefined : { preserveFocus: true },
			);
		} else {
			await vscode.commands.executeCommand('vscode.open', uri, {
				preserveFocus: !makeFrontmost,
			});
		}

		const startText = args?.startText as string | undefined;
		const endText = args?.endText as string | undefined;
		if (startText && !isMarkdown) {
			const editor = vscode.window.activeTextEditor;
			if (
				editor &&
				editor.document.uri.toString() === uri.toString()
			) {
				const fullText = editor.document.getText();
				const startOffset = fullText.indexOf(startText);
				if (startOffset !== -1) {
					let endOffset = startOffset + startText.length;
					if (endText) {
						const after = fullText.indexOf(endText, endOffset);
						if (after !== -1) {
							endOffset = after + endText.length;
						}
					}
					const startPos = editor.document.positionAt(startOffset);
					const endPos = editor.document.positionAt(endOffset);
					editor.selection = new vscode.Selection(startPos, endPos);
					editor.revealRange(
						new vscode.Range(startPos, endPos),
						vscode.TextEditorRevealType.InCenterIfOutsideViewport,
					);
				}
			}
		}

		return {
			content: [
				{ type: 'text', text: `Opened file: ${filePath}` },
			],
		};
	} catch (err) {
		return {
			content: [
				{
					type: 'text',
					text: `Error opening file: ${(err as Error).message}`,
				},
			],
			isError: true,
		};
	}
}

export async function handleOpenDiff(
	args: Record<string, unknown> | undefined,
	context: vscode.ExtensionContext | null,
): Promise<unknown> {
	const oldPath = args?.old_file_path as string | undefined;
	const newPath = (args?.new_file_path as string | undefined) ?? oldPath;
	const newContents = args?.new_file_contents as string | undefined;
	const tabName = (args?.tab_name as string | undefined) ?? 'Claude Edit';

	if (!oldPath || newContents === undefined) {
		return {
			content: [
				{
					type: 'text',
					text: 'Error: old_file_path and new_file_contents are required',
				},
			],
			isError: true,
		};
	}

	// Markdown files go through the Ask Markdown rendered diff: two webview
	// panes showing old and new rendered side-by-side with line-level diff
	// highlights, plus its own Accept/Reject controls. Fall through to the
	// standard text diff for any other file type, and if the extension
	// context hasn't been plumbed in (should never happen in practice).
	if (context && /\.mdx?$/i.test(oldPath)) {
		try {
			const result = await openRenderedMarkdownDiff({
				oldPath,
				newContents,
				tabName,
				context,
			});
			return {
				content: [{ type: 'text', text: result }],
			};
		} catch (err) {
			return {
				content: [
					{
						type: 'text',
						text: `Error opening rendered diff: ${(err as Error).message}`,
					},
				],
				isError: true,
			};
		}
	}

	// Ensure old file exists — create empty if missing so diff can open.
	if (!fs.existsSync(oldPath)) {
		try {
			fs.mkdirSync(path.dirname(oldPath), { recursive: true });
			fs.writeFileSync(oldPath, '', 'utf8');
		} catch (err) {
			return {
				content: [
					{
						type: 'text',
						text: `Error creating old file: ${(err as Error).message}`,
					},
				],
				isError: true,
			};
		}
	}

	// Write proposed contents to a temp file so the right side is editable.
	const basename = sanitizeBasename(path.basename(newPath ?? oldPath));
	const tempPath = path.join(
		os.tmpdir(),
		`ask-markdown-diff-${Date.now()}-${basename}`,
	);
	try {
		fs.writeFileSync(tempPath, newContents, 'utf8');
	} catch (err) {
		return {
			content: [
				{
					type: 'text',
					text: `Error writing temp file: ${(err as Error).message}`,
				},
			],
			isError: true,
		};
	}

	const leftUri = vscode.Uri.file(oldPath);
	const rightUri = vscode.Uri.file(tempPath);

	try {
		await vscode.commands.executeCommand(
			'vscode.diff',
			leftUri,
			rightUri,
			tabName,
		);
	} catch (err) {
		try {
			fs.unlinkSync(tempPath);
		} catch {
			// ignore
		}
		return {
			content: [
				{
					type: 'text',
					text: `Error opening diff: ${(err as Error).message}`,
				},
			],
			isError: true,
		};
	}

	return new Promise<unknown>((resolve) => {
		let resolved = false;
		const disposables: vscode.Disposable[] = [];

		const findDiffTab = (): vscode.Tab | undefined => {
			for (const group of vscode.window.tabGroups.all) {
				for (const tab of group.tabs) {
					const input = tab.input as
						| { modified?: vscode.Uri }
						| undefined;
					if (
						input?.modified &&
						input.modified.toString() === rightUri.toString()
					) {
						return tab;
					}
				}
			}
			return undefined;
		};

		const finish = (result: 'FILE_SAVED' | 'DIFF_REJECTED'): void => {
			if (resolved) {
				return;
			}
			resolved = true;
			for (const d of disposables) {
				d.dispose();
			}
			if (result === 'FILE_SAVED') {
				const diffTab = findDiffTab();
				if (diffTab) {
					void vscode.window.tabGroups.close(diffTab);
				}
			}
			try {
				fs.unlinkSync(tempPath);
			} catch {
				// ignore
			}
			resolve({
				content: [{ type: 'text', text: result }],
			});
		};

		disposables.push(
			vscode.workspace.onDidSaveTextDocument((doc) => {
				if (doc.uri.toString() === rightUri.toString()) {
					try {
						fs.writeFileSync(oldPath, doc.getText(), 'utf8');
						finish('FILE_SAVED');
					} catch {
						finish('DIFF_REJECTED');
					}
				}
			}),
			vscode.window.tabGroups.onDidChangeTabs((e) => {
				for (const tab of e.closed) {
					const input = tab.input as
						| { modified?: vscode.Uri }
						| undefined;
					if (
						input?.modified &&
						input.modified.toString() === rightUri.toString()
					) {
						finish('DIFF_REJECTED');
						return;
					}
				}
			}),
		);
	});
}

export async function handleCloseTab(
	args: Record<string, unknown> | undefined,
): Promise<unknown> {
	const tabName = args?.tab_name as string | undefined;
	if (!tabName) {
		return {
			content: [{ type: 'text', text: 'Error: tab_name is required' }],
			isError: true,
		};
	}
	// Rendered-diff webviews are tracked by tab_name, so dispose those
	// directly — more reliable than matching via TabInputWebview.viewType,
	// which VS Code exposes inconsistently across builds.
	const closedPanel = disposeRenderedDiffByTabName(tabName);

	// Scope the tab-list scan to diff tabs. Claude Code passes the filename
	// as tab_name, which collides with the label of any plain editor the
	// user already had open for the same file — matching by label alone
	// would close their tab too.
	const toClose: vscode.Tab[] = [];
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			if (tab.label === tabName && isDiffTab(tab)) {
				toClose.push(tab);
			}
		}
	}
	if (toClose.length === 0 && !closedPanel) {
		return {
			content: [
				{ type: 'text', text: `No tab found with name: ${tabName}` },
			],
		};
	}
	try {
		if (toClose.length > 0) {
			await vscode.window.tabGroups.close(toClose);
		}
		const closedCount = toClose.length + (closedPanel ? 1 : 0);
		return {
			content: [
				{
					type: 'text',
					text: `Closed ${closedCount} tab(s) named "${tabName}"`,
				},
			],
		};
	} catch (err) {
		return {
			content: [
				{
					type: 'text',
					text: `Error closing tab: ${(err as Error).message}`,
				},
			],
			isError: true,
		};
	}
}

export async function handleCloseAllDiffTabs(): Promise<unknown> {
	const closedPanels = disposeAllRenderedDiffs();
	const toClose: vscode.Tab[] = [];
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			if (isDiffTab(tab)) {
				toClose.push(tab);
			}
		}
	}
	if (toClose.length === 0 && closedPanels === 0) {
		return {
			content: [{ type: 'text', text: 'No diff tabs to close' }],
		};
	}
	try {
		if (toClose.length > 0) {
			await vscode.window.tabGroups.close(toClose);
		}
		const total = toClose.length + closedPanels;
		return {
			content: [
				{
					type: 'text',
					text: `Closed ${total} diff tab(s)`,
				},
			],
		};
	} catch (err) {
		return {
			content: [
				{
					type: 'text',
					text: `Error closing diff tabs: ${(err as Error).message}`,
				},
			],
			isError: true,
		};
	}
}
