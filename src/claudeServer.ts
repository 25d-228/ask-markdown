import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import {
	cleanStaleLockFiles,
	listWorkspaceFolders,
	removeLockFile,
	writeLockFile,
} from './server/lockFile';
import {
	handleCloseAllDiffTabs,
	handleCloseTab,
	handleOpenDiff,
	handleOpenFile,
	toolDefinitions,
} from './server/tools';

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
let extensionContext: vscode.ExtensionContext | null = null;
const clients = new Set<WebSocket>();

export function updateLatestSelection(sel: LatestSelection): void {
	if (!sel.selection.isEmpty) {
		latestSelection = sel;
	}
}

function generateAuthToken(): string {
	return crypto.randomUUID();
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
				{ type: 'text', text: JSON.stringify(listWorkspaceFolders()) },
			],
		};
	} else if (name === 'openFile') {
		return handleOpenFile(args);
	} else if (name === 'openDiff') {
		return handleOpenDiff(args, extensionContext);
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
				result: toolDefinitions,
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

export function startServer(
	context: vscode.ExtensionContext,
): Promise<number> {
	extensionContext = context;
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
	extensionContext = null;
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
