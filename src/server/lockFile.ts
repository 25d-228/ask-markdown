import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const LOCK_DIR = path.join(os.homedir(), '.claude', 'ide');
const IDE_NAME = 'Ask Markdown';

interface LockFile {
	pid: number;
	workspaceFolders: string[];
	ideName: string;
	transport: string;
	runningInWindows: boolean;
	authToken: string;
}

export function listWorkspaceFolders(): string[] {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders) {
		return [];
	}
	return folders.map((f) => f.uri.fsPath);
}

export function writeLockFile(port: number, token: string): void {
	fs.mkdirSync(LOCK_DIR, { recursive: true });
	const lockData: LockFile = {
		pid: process.pid,
		workspaceFolders: listWorkspaceFolders(),
		ideName: IDE_NAME,
		transport: 'ws',
		runningInWindows: process.platform === 'win32',
		authToken: token,
	};
	fs.writeFileSync(
		path.join(LOCK_DIR, `${port}.lock`),
		JSON.stringify(lockData),
	);
}

export function removeLockFile(port: number): void {
	try {
		fs.unlinkSync(path.join(LOCK_DIR, `${port}.lock`));
	} catch {
		// Already removed.
	}
}

// Remove lock files left behind by crashed Ask Markdown instances. We only
// touch files whose `ideName` identifies them as ours, and only when the
// recorded pid is no longer alive.
export function cleanStaleLockFiles(): void {
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
		if (data.ideName !== IDE_NAME || typeof data.pid !== 'number') {
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
