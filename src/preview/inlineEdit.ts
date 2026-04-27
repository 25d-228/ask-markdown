import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type InlineEditPost = (msg: { type: string; [key: string]: unknown }) => void;

export interface InlineEditOptions {
	document: vscode.TextDocument;
	startLine: number;
	endLine: number;
	selectedText: string;
	instruction: string;
	post: InlineEditPost;
}

export class InlineEditRunner {
	private proc: ReturnType<typeof spawn> | null = null;

	start(opts: InlineEditOptions): void {
		if (this.proc) {
			this.proc.kill();
			this.proc = null;
		}

		const { document, startLine, endLine, selectedText, instruction, post } = opts;

		if (!instruction) {
			post({
				type: 'inlineEditError',
				error: 'Empty instruction',
			});
			return;
		}

		// Write the current in-memory document content to a scratch file we
		// own. Claude edits that copy; we apply the result back to the real
		// document via WorkspaceEdit so the change goes through VS Code's
		// normal text edit pipeline (undo-able, no file watcher dependency,
		// works even when the document has unsaved changes).
		const baseName = path.basename(document.uri.fsPath) || 'doc.md';
		const safeBase = baseName.replace(/[^a-zA-Z0-9._-]/g, '_');
		const tempPath = path.join(
			os.tmpdir(),
			`ask-markdown-edit-${Date.now()}-${safeBase}`,
		);
		try {
			fs.writeFileSync(tempPath, document.getText(), 'utf8');
		} catch (err) {
			post({
				type: 'inlineEditError',
				error: `Failed to create scratch file: ${(err as Error).message}`,
			});
			return;
		}

		const cleanup = (): void => {
			try {
				fs.unlinkSync(tempPath);
			} catch {
				// Already gone.
			}
		};

		const prompt =
			`File to edit: ${tempPath}\n` +
			`Lines ${startLine}-${endLine} (1-based, inclusive) currently contain the text between the <selection> tags below:\n\n` +
			`<selection>\n${selectedText}\n</selection>\n\n` +
			`User instruction: ${instruction}\n\n` +
			'Use your Edit tool to apply the instruction to the selected lines in the file. ' +
			'Read the file first if you need surrounding context to make the old_string unique. ' +
			'Output nothing — just edit the file and exit.';

		const proc = spawn(
			'claude',
			[
				'-p',
				'--output-format', 'text',
				'--model', 'sonnet',
				'--allowedTools', 'Read,Edit',
			],
			{ stdio: ['pipe', 'pipe', 'pipe'] },
		);
		this.proc = proc;

		const errChunks: Buffer[] = [];
		// Keep the tail of stdout so we can surface Claude's own complaint
		// when exit is non-zero and stderr is empty.
		const stdoutTailLimit = 4096;
		let stdoutTail = '';

		proc.stdout!.on('data', (data: Buffer) => {
			stdoutTail = (stdoutTail + data.toString()).slice(-stdoutTailLimit);
		});
		proc.stderr!.on('data', (data: Buffer) => {
			errChunks.push(data);
		});

		proc.on('close', async (code, signal) => {
			if (this.proc !== proc) {
				return;
			}
			this.proc = null;
			if (signal === 'SIGTERM' || signal === 'SIGKILL') {
				cleanup();
				post({ type: 'inlineEditDone' });
				return;
			}
			if (code !== 0) {
				const stderr = Buffer.concat(errChunks).toString().trim();
				const detail = stderr || stdoutTail.trim();
				cleanup();
				post({
					type: 'inlineEditError',
					error: `Claude exited with code ${code}${detail ? ': ' + detail : ''}`,
				});
				return;
			}
			try {
				const newContent = fs.readFileSync(tempPath, 'utf8');
				if (newContent !== document.getText()) {
					const fullRange = new vscode.Range(
						document.positionAt(0),
						document.positionAt(document.getText().length),
					);
					const edit = new vscode.WorkspaceEdit();
					edit.replace(document.uri, fullRange, newContent);
					await vscode.workspace.applyEdit(edit);
				}
				post({ type: 'inlineEditDone' });
			} catch (err) {
				post({
					type: 'inlineEditError',
					error: `Failed to apply edit: ${(err as Error).message}`,
				});
			} finally {
				cleanup();
			}
		});

		proc.on('error', (err) => {
			if (this.proc !== proc) {
				return;
			}
			this.proc = null;
			cleanup();
			post({
				type: 'inlineEditError',
				error: `Failed to run claude: ${err.message}`,
			});
		});

		proc.stdin!.write(prompt);
		proc.stdin!.end();
	}

	cancel(): void {
		if (this.proc) {
			this.proc.kill();
			this.proc = null;
		}
	}

	dispose(): void {
		this.cancel();
	}
}
