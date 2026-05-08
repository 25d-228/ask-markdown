import { spawn } from 'node:child_process';
import type { ClientSideConnection } from '@agentclientprotocol/sdk';

const SPAWN_TIMEOUT_MS = 3000;

// Stub. Spawns claude-agent-acp via npx, reads its stderr until the timeout
// fires, then kills it. The next step wires a real ClientSideConnection
// over stdin/stdout.
export async function runOneShot(
	prompt: string,
): Promise<ClientSideConnection | null> {
	console.log(
		'[ask-markdown:acp] runOneShot stub, prompt length:',
		prompt.length,
	);

	const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
	const proc = spawn(cmd, ['-y', '@zed-industries/claude-agent-acp'], {
		stdio: ['pipe', 'pipe', 'pipe'],
	});

	proc.stderr.on('data', (chunk: Buffer) => {
		console.log('[acp:stderr]', chunk.toString().trimEnd());
	});

	proc.on('error', (err) => {
		console.error('[ask-markdown:acp] spawn error:', err);
	});

	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			console.log('[ask-markdown:acp] killing subprocess after timeout');
			proc.kill('SIGTERM');
		}, SPAWN_TIMEOUT_MS);
		proc.on('exit', (code, signal) => {
			clearTimeout(timer);
			console.log('[ask-markdown:acp] subprocess exited:', {
				code,
				signal,
			});
			resolve();
		});
	});

	return null;
}
