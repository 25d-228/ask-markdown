import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';

const LOCK_DIR = path.join(os.homedir(), '.claude', 'ide');

interface LockFile {
	pid: number;
	workspaceFolders: string[];
	ideName: string;
	transport: string;
	runningInWindows: boolean;
	authToken: string;
}

interface JsonRpcRequest {
	jsonrpc: string;
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
}

export interface LatestSelection {
	text: string;
	filePath: string;
	fileUrl: string;
	selection: {
		start: { line: number; character: number };
		end: { line: number; character: number };
		isEmpty: boolean;
	};
}

let wss: WebSocketServer | null = null;
let serverPort: number | null = null;
let authToken: string | null = null;
let latestSelection: LatestSelection | null = null;
const clients = new Set<WebSocket>();

export function updateLatestSelection(sel: LatestSelection): void {
	if (!sel.selection.isEmpty) {
		latestSelection = sel;
	}
}

function generateAuthToken(): string {
	return crypto.randomUUID();
}

function getWorkspaceFolders(): string[] {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders) {
		return [];
	}
	return folders.map((f) => f.uri.fsPath);
}

function writeLockFile(port: number, token: string): void {
	fs.mkdirSync(LOCK_DIR, { recursive: true });
	const lockData: LockFile = {
		pid: process.pid,
		workspaceFolders: getWorkspaceFolders(),
		ideName: 'Ask Markdown',
		transport: 'ws',
		runningInWindows: process.platform === 'win32',
		authToken: token,
	};
	fs.writeFileSync(
		path.join(LOCK_DIR, `${port}.lock`),
		JSON.stringify(lockData),
	);
}

function removeLockFile(port: number): void {
	try {
		fs.unlinkSync(path.join(LOCK_DIR, `${port}.lock`));
	} catch {
		// Already removed.
	}
}

// Remove lock files left behind by crashed Ask Markdown instances. We only
// touch files whose `ideName` identifies them as ours, and only when the
// recorded pid is no longer alive.
function cleanStaleLockFiles(): void {
	let entries: string[];
	try {
		entries = fs.readdirSync(LOCK_DIR);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.endsWith('.lock')) {
			continue;
		}
		const fullPath = path.join(LOCK_DIR, entry);
		let data: LockFile;
		try {
			data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
		} catch {
			continue;
		}
		if (data.ideName !== 'Ask Markdown' || typeof data.pid !== 'number') {
			continue;
		}
		let alive = false;
		try {
			process.kill(data.pid, 0);
			alive = true;
		} catch (err) {
			// EPERM means the pid exists but we lack permission to signal it.
			if ((err as NodeJS.ErrnoException).code === 'EPERM') {
				alive = true;
			}
		}
		if (alive) {
			continue;
		}
		try {
			fs.unlinkSync(fullPath);
		} catch {
			// ignore
		}
	}
}

const MARKDOWN_VIEW_TYPE = 'askMarkdown.preview';

function handleToolsList(): unknown {
	return {
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
}

function isDiffTab(tab: vscode.Tab): boolean {
	const input = tab.input as
		| { original?: vscode.Uri; modified?: vscode.Uri }
		| undefined;
	return Boolean(input?.original && input?.modified);
}

async function handleCloseTab(
	args: Record<string, unknown> | undefined,
): Promise<unknown> {
	const tabName = args?.tab_name as string | undefined;
	if (!tabName) {
		return {
			content: [{ type: 'text', text: 'Error: tab_name is required' }],
			isError: true,
		};
	}
	// Scope to diff tabs. Claude Code passes the filename as tab_name, which
	// collides with the label of any plain editor the user already had open
	// for the same file — matching by label alone would close their tab too.
	const toClose: vscode.Tab[] = [];
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			if (tab.label === tabName && isDiffTab(tab)) {
				toClose.push(tab);
			}
		}
	}
	if (toClose.length === 0) {
		return {
			content: [
				{ type: 'text', text: `No tab found with name: ${tabName}` },
			],
		};
	}
	try {
		await vscode.window.tabGroups.close(toClose);
		return {
			content: [
				{
					type: 'text',
					text: `Closed ${toClose.length} tab(s) named "${tabName}"`,
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

async function handleCloseAllDiffTabs(): Promise<unknown> {
	const toClose: vscode.Tab[] = [];
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			if (isDiffTab(tab)) {
				toClose.push(tab);
			}
		}
	}
	if (toClose.length === 0) {
		return {
			content: [{ type: 'text', text: 'No diff tabs to close' }],
		};
	}
	try {
		await vscode.window.tabGroups.close(toClose);
		return {
			content: [
				{
					type: 'text',
					text: `Closed ${toClose.length} diff tab(s)`,
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

async function handleOpenFile(
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

function sanitizeBasename(name: string): string {
	return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function handleOpenDiff(
	args: Record<string, unknown> | undefined,
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

async function handleToolCall(
	name: string,
	args: Record<string, unknown> | undefined,
): Promise<unknown> {
	if (name === 'getCurrentSelection') {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify({
							success: false,
							message: 'No active editor',
						}),
					},
				],
			};
		}
		const sel = editor.selection;
		const text = editor.document.getText(sel);
		const filePath = editor.document.uri.fsPath;
		const fileUrl = editor.document.uri.toString();
		return {
			content: [
				{
					type: 'text',
					text: JSON.stringify({
						success: true,
						text,
						filePath,
						fileUrl,
						selection: {
							start: {
								line: sel.start.line,
								character: sel.start.character,
							},
							end: {
								line: sel.end.line,
								character: sel.end.character,
							},
							isEmpty: sel.isEmpty,
						},
					}),
				},
			],
		};
	} else if (name === 'getLatestSelection') {
		if (!latestSelection) {
			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify({
							success: false,
							message: 'No selection available',
						}),
					},
				],
			};
		}
		return {
			content: [
				{
					type: 'text',
					text: JSON.stringify({
						success: true,
						...latestSelection,
					}),
				},
			],
		};
	} else if (name === 'getDiagnostics') {
		return { content: [] };
	} else if (name === 'getOpenEditors') {
		const tabs = vscode.window.tabGroups.all.flatMap((g) =>
			g.tabs
				.map((t) => {
					const input = t.input as { uri?: vscode.Uri } | undefined;
					return input?.uri?.fsPath;
				})
				.filter((p): p is string => typeof p === 'string' && p.length > 0),
		);
		return {
			content: [{ type: 'text', text: JSON.stringify(tabs) }],
		};
	} else if (name === 'getWorkspaceFolders') {
		return {
			content: [
				{ type: 'text', text: JSON.stringify(getWorkspaceFolders()) },
			],
		};
	} else if (name === 'openFile') {
		return handleOpenFile(args);
	} else if (name === 'openDiff') {
		return handleOpenDiff(args);
	} else if (name === 'close_tab') {
		return handleCloseTab(args);
	} else if (name === 'closeAllDiffTabs') {
		return handleCloseAllDiffTabs();
	}
	return { error: { code: -32601, message: `Unknown tool: ${name}` } };
}

async function handleMessage(ws: WebSocket, data: string): Promise<void> {
	let request: JsonRpcRequest;
	try {
		request = JSON.parse(data);
	} catch {
		return;
	}

	if (request.method === 'initialize') {
		const response = {
			jsonrpc: '2.0',
			id: request.id,
			result: {
				protocolVersion: '2024-11-05',
				capabilities: {
					tools: { listChanged: true },
				},
				serverInfo: {
					name: 'ask-markdown',
					version: '0.0.1',
				},
			},
		};
		ws.send(JSON.stringify(response));
	} else if (request.method === 'notifications/initialized') {
		// No response needed for notifications.
	} else if (request.method === 'prompts/list') {
		ws.send(
			JSON.stringify({
				jsonrpc: '2.0',
				id: request.id,
				result: { prompts: [] },
			}),
		);
	} else if (request.method === 'tools/list') {
		ws.send(
			JSON.stringify({
				jsonrpc: '2.0',
				id: request.id,
				result: handleToolsList(),
			}),
		);
	} else if (request.method === 'tools/call') {
		const params = request.params as
			| { name: string; arguments?: Record<string, unknown> }
			| undefined;
		const result = await handleToolCall(
			params?.name ?? '',
			params?.arguments,
		);
		ws.send(
			JSON.stringify({
				jsonrpc: '2.0',
				id: request.id,
				result,
			}),
		);
	} else if (request.id !== undefined) {
		// Unknown method with an id — send error.
		ws.send(
			JSON.stringify({
				jsonrpc: '2.0',
				id: request.id,
				error: {
					code: -32601,
					message: `Method not found: ${request.method}`,
				},
			}),
		);
	}
}

export function startServer(): Promise<number> {
	return new Promise((resolve, reject) => {
		if (wss) {
			resolve(serverPort!);
			return;
		}

		authToken = generateAuthToken();

		cleanStaleLockFiles();

		const server = http.createServer();
		wss = new WebSocketServer({ noServer: true });

		server.on('upgrade', (req, socket, head) => {
			const token = req.headers['x-claude-code-ide-authorization'];
			if (token !== authToken) {
				socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
				socket.destroy();
				return;
			}
			wss!.handleUpgrade(req, socket, head, (ws) => {
				wss!.emit('connection', ws, req);
			});
		});

		wss.on('connection', (ws) => {
			clients.add(ws);
			console.log('[ask-markdown] Claude CLI connected');
			ws.on('message', (data) => {
				void handleMessage(ws, data.toString());
			});
			ws.on('close', () => {
				clients.delete(ws);
				console.log('[ask-markdown] Claude CLI disconnected');
			});
		});

		// Listen on a random port.
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address();
			if (!addr || typeof addr === 'string') {
				reject(new Error('Failed to get server address'));
				return;
			}
			serverPort = addr.port;
			writeLockFile(serverPort, authToken!);
			console.log(
				`[ask-markdown] WebSocket server listening on port ${serverPort}`,
			);
			resolve(serverPort);
		});

		server.on('error', reject);
	});
}

export function stopServer(): void {
	if (serverPort) {
		removeLockFile(serverPort);
	}
	for (const ws of clients) {
		ws.close();
	}
	clients.clear();
	if (wss) {
		wss.close();
		wss = null;
	}
	serverPort = null;
	authToken = null;
	latestSelection = null;
}

export function broadcast(method: string, params: unknown): boolean {
	if (clients.size === 0) {
		return false;
	}
	const message = JSON.stringify({
		jsonrpc: '2.0',
		method,
		params,
	});
	for (const ws of clients) {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(message);
		}
	}
	return true;
}

export function isConnected(): boolean {
	return clients.size > 0;
}
