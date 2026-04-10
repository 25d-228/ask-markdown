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

let wss: WebSocketServer | null = null;
let serverPort: number | null = null;
let authToken: string | null = null;
const clients = new Set<WebSocket>();

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
		],
	};
}

function handleToolCall(name: string): unknown {
	if (name === 'getCurrentSelection') {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.selection.isEmpty) {
			return {
				content: [{ type: 'text', text: '' }],
			};
		}
		const text = editor.document.getText(editor.selection);
		const filePath = editor.document.uri.fsPath;
		const startLine = editor.selection.start.line + 1;
		const endLine = editor.selection.end.line + 1;
		return {
			content: [
				{
					type: 'text',
					text: JSON.stringify({
						text,
						filePath,
						startLine,
						endLine,
					}),
				},
			],
		};
	} else if (name === 'getOpenEditors') {
		const tabs = vscode.window.tabGroups.all.flatMap((g) =>
			g.tabs
				.map((t) => {
					const input = t.input as { uri?: vscode.Uri } | undefined;
					return input?.uri?.fsPath;
				})
				.filter(Boolean),
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
	}
	return { error: { code: -32601, message: `Unknown tool: ${name}` } };
}

function handleMessage(ws: WebSocket, data: string): void {
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
		const result = handleToolCall(params?.name ?? '');
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
				handleMessage(ws, data.toString());
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
