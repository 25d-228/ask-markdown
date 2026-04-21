import * as vscode from 'vscode';
import * as fs from 'fs';
import { createMarkdownIt } from './markdownRenderer';

const md = createMarkdownIt();

export type DiffResult = 'FILE_SAVED' | 'DIFF_REJECTED';

export interface RenderedDiffOptions {
	oldPath: string;
	newContents: string;
	tabName: string;
	context: vscode.ExtensionContext;
}

// LCS-based line diff over raw source. Returns 1-based line numbers that were
// removed from old and added in new. Bails on very large inputs (O(n*m) memory
// would explode) by treating every line as changed — still renders the two
// sides correctly, just without fine-grained highlighting.
function computeLineDiff(
	oldSource: string,
	newSource: string,
): { removedLines: number[]; addedLines: number[] } {
	const oldLines = oldSource.split('\n');
	const newLines = newSource.split('\n');
	const n = oldLines.length;
	const m = newLines.length;

	const BAIL = 3000;
	if (n > BAIL || m > BAIL) {
		return {
			removedLines: Array.from({ length: n }, (_, i) => i + 1),
			addedLines: Array.from({ length: m }, (_, i) => i + 1),
		};
	}

	const dp: Int32Array[] = [];
	for (let i = 0; i <= n; i++) {
		dp.push(new Int32Array(m + 1));
	}
	for (let i = 1; i <= n; i++) {
		for (let j = 1; j <= m; j++) {
			if (oldLines[i - 1] === newLines[j - 1]) {
				dp[i][j] = dp[i - 1][j - 1] + 1;
			} else {
				dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
			}
		}
	}

	const removedLines: number[] = [];
	const addedLines: number[] = [];
	let i = n;
	let j = m;
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
			i--;
			j--;
		} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
			addedLines.push(j);
			j--;
		} else {
			removedLines.push(i);
			i--;
		}
	}
	return { removedLines, addedLines };
}

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let nonce = '';
	for (let i = 0; i < 32; i++) {
		nonce += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return nonce;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function renderBody(source: string): string {
	try {
		return md.render(source, { source });
	} catch {
		return `<pre>${escapeHtml(source)}</pre>`;
	}
}

function buildDiffHtml(
	webview: vscode.Webview,
	extensionUri: vscode.Uri,
	data: {
		oldBody: string;
		newBody: string;
		removedLines: number[];
		addedLines: number[];
		tabName: string;
	},
): string {
	const nonce = getNonce();
	const previewCssUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'media', 'preview.css'),
	);
	const diffCssUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'media', 'rendered-diff.css'),
	);
	const katexCssUri = webview.asWebviewUri(
		vscode.Uri.joinPath(
			extensionUri,
			'node_modules',
			'katex',
			'dist',
			'katex.min.css',
		),
	);
	const jsUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'media', 'rendered-diff.js'),
	);
	const csp = [
		`default-src 'none'`,
		`img-src ${webview.cspSource} data:`,
		`style-src ${webview.cspSource} 'unsafe-inline'`,
		`script-src 'nonce-${nonce}'`,
		`font-src ${webview.cspSource}`,
	].join('; ');

	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="${csp}" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link rel="stylesheet" href="${katexCssUri}" />
	<link rel="stylesheet" href="${previewCssUri}" />
	<link rel="stylesheet" href="${diffCssUri}" />
	<title>${escapeHtml(data.tabName)}</title>
</head>
<body>
<div id="diff-root">
	<div id="diff-panes">
		<div class="diff-pane" id="old-pane">
			<div class="diff-pane-label">Original</div>
			<article class="diff-content">${data.oldBody}</article>
		</div>
		<div class="diff-pane" id="new-pane">
			<div class="diff-pane-label">Proposed</div>
			<article class="diff-content">${data.newBody}</article>
		</div>
	</div>
</div>
<script nonce="${nonce}">
	window.__diffData__ = {
		removedLines: ${JSON.stringify(data.removedLines)},
		addedLines: ${JSON.stringify(data.addedLines)},
	};
</script>
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

async function readOldContents(oldUri: vscode.Uri, oldPath: string): Promise<string> {
	if (!fs.existsSync(oldPath)) {
		return '';
	}
	try {
		const doc = await vscode.workspace.openTextDocument(oldUri);
		return doc.getText();
	} catch {
		try {
			return fs.readFileSync(oldPath, 'utf8');
		} catch {
			return '';
		}
	}
}

export async function openRenderedMarkdownDiff(
	opts: RenderedDiffOptions,
): Promise<DiffResult> {
	const oldUri = vscode.Uri.file(opts.oldPath);
	const oldContents = await readOldContents(oldUri, opts.oldPath);

	const panel = vscode.window.createWebviewPanel(
		'askMarkdown.renderedDiff',
		opts.tabName,
		vscode.ViewColumn.Active,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [
				vscode.Uri.joinPath(opts.context.extensionUri, 'media'),
				vscode.Uri.joinPath(
					opts.context.extensionUri,
					'node_modules',
					'katex',
					'dist',
				),
			],
		},
	);

	const { removedLines, addedLines } = computeLineDiff(
		oldContents,
		opts.newContents,
	);

	panel.webview.html = buildDiffHtml(
		panel.webview,
		opts.context.extensionUri,
		{
			oldBody: renderBody(oldContents),
			newBody: renderBody(opts.newContents),
			removedLines,
			addedLines,
			tabName: opts.tabName,
		},
	);

	// No in-webview Accept/Reject: the decision is driven from the Claude
	// Code terminal. On accept, Claude writes the file (via its own Edit
	// tool) and calls close_tab to dismiss this webview. On reject, Claude
	// just calls close_tab without writing. Either way the panel disposes,
	// at which point we compare the file on disk to the proposed contents:
	// a match means Claude wrote it (FILE_SAVED), otherwise DIFF_REJECTED.
	return new Promise<DiffResult>((resolve) => {
		let resolved = false;
		const finish = (result: DiffResult): void => {
			if (resolved) {
				return;
			}
			resolved = true;
			resolve(result);
		};

		panel.onDidDispose(() => {
			let current = '';
			try {
				current = fs.readFileSync(opts.oldPath, 'utf8');
			} catch {
				current = '';
			}
			finish(
				current === opts.newContents ? 'FILE_SAVED' : 'DIFF_REJECTED',
			);
		});
	});
}
