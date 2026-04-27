import * as vscode from 'vscode';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function fileUrl(absolutePath: string): string {
	let p = path.resolve(absolutePath).replace(/\\/g, '/');
	if (!p.startsWith('/')) {
		p = '/' + p;
	}
	return 'file://' + p.split('/').map(encodeURIComponent).join('/').replace(/%3A/gi, ':');
}

function findChromeExecutable(): string | undefined {
	const exists = (p: string): boolean => {
		try {
			return fs.statSync(p).isFile();
		} catch {
			return false;
		}
	};

	if (process.platform === 'darwin') {
		const macCandidates = [
			'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
			'/Applications/Chromium.app/Contents/MacOS/Chromium',
			'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
			'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
		];
		for (const c of macCandidates) {
			if (exists(c)) {
				return c;
			}
		}
		return undefined;
	}

	if (process.platform === 'win32') {
		const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files';
		const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
		const localAppData = process.env['LOCALAPPDATA'] ?? '';
		const winCandidates = [
			path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
			path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
			localAppData
				? path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')
				: '',
			path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
			path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
			path.join(pf, 'Chromium', 'Application', 'chrome.exe'),
		].filter(Boolean);
		for (const c of winCandidates) {
			if (exists(c)) {
				return c;
			}
		}
		return undefined;
	}

	// Linux / other unix
	const names = [
		'google-chrome-stable',
		'google-chrome',
		'chromium',
		'chromium-browser',
		'microsoft-edge',
		'microsoft-edge-stable',
		'brave-browser',
	];
	for (const name of names) {
		const which = spawnSync('which', [name], { encoding: 'utf8' });
		if (which.status === 0) {
			const resolved = which.stdout.trim();
			if (resolved && exists(resolved)) {
				return resolved;
			}
		}
	}
	const linuxCandidates = [
		'/usr/bin/google-chrome',
		'/usr/bin/google-chrome-stable',
		'/usr/bin/chromium',
		'/usr/bin/chromium-browser',
		'/snap/bin/chromium',
		'/usr/bin/microsoft-edge',
	];
	for (const c of linuxCandidates) {
		if (exists(c)) {
			return c;
		}
	}
	return undefined;
}

function buildPdfHtml(
	renderedBody: string,
	style: string,
	themeClass: string,
	docDir: string,
	cssPath: string,
	katexCssPath: string,
): string {
	const safeStyle = /^[a-z]+$/.test(style) ? style : 'clean';
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<base href="${fileUrl(docDir)}/" />
<link rel="stylesheet" href="${fileUrl(katexCssPath)}" />
<link rel="stylesheet" href="${fileUrl(cssPath)}" />
<title>Ask Markdown PDF</title>
</head>
<body class="${themeClass} pdf-style-${safeStyle}">
<div id="app">
<div id="view-container">
<div id="content-scroll">
<article id="content">${renderedBody}</article>
</div>
</div>
</div>
</body>
</html>`;
}

function runChromePdf(
	chromeExec: string,
	htmlPath: string,
	pdfPath: string,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const args = [
			'--headless=new',
			'--disable-gpu',
			'--no-sandbox',
			'--no-pdf-header-footer',
			'--hide-scrollbars',
			`--print-to-pdf=${pdfPath}`,
			fileUrl(htmlPath),
		];
		const proc = spawn(chromeExec, args, {
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const errChunks: Buffer[] = [];
		proc.stderr.on('data', (c: Buffer) => errChunks.push(c));
		proc.on('error', reject);
		proc.on('close', (code) => {
			if (code === 0) {
				resolve();
			} else {
				const detail = Buffer.concat(errChunks).toString().trim();
				reject(
					new Error(
						`Chrome exited with code ${code}${detail ? ': ' + detail.slice(0, 500) : ''}`,
					),
				);
			}
		});
	});
}

export async function exportPdf(
	document: vscode.TextDocument,
	style: string,
	extensionPath: string,
	renderBody: (source: string) => string,
): Promise<void> {
	const chromeExec = findChromeExecutable();
	if (!chromeExec) {
		vscode.window.showErrorMessage(
			'Ask Markdown: PDF export requires Google Chrome, Chromium, Microsoft Edge, or Brave to be installed.',
		);
		return;
	}

	const baseName = path.basename(document.uri.fsPath, '.md') || 'document';
	const docDir =
		document.uri.scheme === 'file'
			? path.dirname(document.uri.fsPath)
			: os.homedir();
	const defaultUri = vscode.Uri.file(path.join(docDir, `${baseName}.pdf`));
	const saveUri = await vscode.window.showSaveDialog({
		defaultUri,
		filters: { PDF: ['pdf'] },
		saveLabel: 'Export PDF',
	});
	if (!saveUri) {
		return;
	}

	const cssPath = path.join(extensionPath, 'media', 'preview.css');
	const katexCssPath = path.join(
		extensionPath,
		'node_modules',
		'katex',
		'dist',
		'katex.min.css',
	);

	const themeKind = vscode.window.activeColorTheme.kind;
	// pdf-style-theme should preserve what the user sees; the other presets
	// repaint the page with a light background, so pair them with the light
	// hljs palette for legible code blocks.
	let themeClass = 'vscode-light';
	if (style === 'theme') {
		if (themeKind === vscode.ColorThemeKind.Dark) {
			themeClass = 'vscode-dark';
		} else if (themeKind === vscode.ColorThemeKind.HighContrast) {
			themeClass = 'vscode-high-contrast';
		}
	}

	const source = document.getText();
	const body = renderBody(source);
	const html = buildPdfHtml(
		body,
		style,
		themeClass,
		docDir,
		cssPath,
		katexCssPath,
	);

	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-markdown-pdf-'));
	const tempHtmlPath = path.join(tempDir, 'doc.html');

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'Ask Markdown: exporting PDF…',
			cancellable: false,
		},
		async () => {
			try {
				fs.writeFileSync(tempHtmlPath, html, 'utf8');
				await runChromePdf(chromeExec, tempHtmlPath, saveUri.fsPath);
			} finally {
				try {
					fs.rmSync(tempDir, { recursive: true, force: true });
				} catch {
					// ignore cleanup failure
				}
			}
		},
	).then(
		async () => {
			const pick = await vscode.window.showInformationMessage(
				`PDF exported: ${path.basename(saveUri.fsPath)}`,
				'Open',
			);
			if (pick === 'Open') {
				await vscode.env.openExternal(saveUri);
			}
		},
		(err: Error) => {
			vscode.window.showErrorMessage(
				`Ask Markdown: PDF export failed: ${err.message}`,
			);
		},
	);
}
