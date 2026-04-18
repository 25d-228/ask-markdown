import * as vscode from 'vscode';
import MarkdownIt from 'markdown-it';
const texmath = require('markdown-it-texmath');
const katex = require('katex');
const hljs = require('highlight.js/lib/common');
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { toRange } from './sourceMapper';
import { broadcast, isConnected, updateLatestSelection } from './claudeServer';

type Token = Parameters<MarkdownIt['renderer']['render']>[0][number];

/**
 * Build a markdown-it instance whose block-level opening tags carry
 * `data-source-line` / `data-source-line-end` attributes derived from
 * `token.map`. The webview reads these to map a DOM selection back to a
 * source line range.
 */
export function createMarkdownIt(): MarkdownIt {
	const md = new MarkdownIt({
		html: true,
		linkify: true,
		breaks: false,
		highlight: (str: string, lang: string): string => {
			if (lang && hljs.getLanguage(lang)) {
				try {
					return hljs.highlight(str, {
						language: lang,
						ignoreIllegals: true,
					}).value;
				} catch {
					// fall through
				}
			}
			return '';
		},
	});

	md.use(texmath, { engine: katex, delimiters: 'dollars' });

	// markdown-it's paragraph tokens commonly include the trailing blank
	// line in `token.map`, which would make `data-source-line-end` point one
	// line past the last line of actual content. Trim those blanks using the
	// source text passed via `env.source`.
	const trimTrailingBlank = (
		startLine: number,
		endLine: number,
		env: unknown,
	): number => {
		const source = (env as { source?: unknown })?.source;
		if (typeof source !== 'string') {
			return endLine;
		}
		const lines = source.split('\n');
		let trimmed = endLine;
		while (
			trimmed > startLine &&
			trimmed - 1 < lines.length &&
			!lines[trimmed - 1].trim()
		) {
			trimmed--;
		}
		return trimmed;
	};

	const injectSourceMap = (
		tokens: Token[],
		idx: number,
		env: unknown,
	): void => {
		const token = tokens[idx];
		if (!token.map) {
			return;
		}
		const startLine = token.map[0] + 1;
		const endLine = trimTrailingBlank(startLine, token.map[1], env);
		token.attrJoin('data-source-line', String(startLine));
		token.attrJoin('data-source-line-end', String(endLine));
	};

	const sourceMapTypes = [
		'paragraph_open',
		'heading_open',
		'bullet_list_open',
		'ordered_list_open',
		'list_item_open',
		'blockquote_open',
		'table_open',
		'tr_open',
		'hr',
		'fence',
		'code_block',
	];

	for (const type of sourceMapTypes) {
		const previous = md.renderer.rules[type];
		md.renderer.rules[type] = (tokens, idx, options, env, self) => {
			injectSourceMap(tokens, idx, env);
			return previous
				? previous(tokens, idx, options, env, self)
				: self.renderToken(tokens, idx, options);
		};
	}

	// GitHub-style heading slug: lowercase, strip punctuation, spaces → hyphens.
	// Enables fragment links like `[...](#1-the-trick-in-one-paragraph)`.
	const slugify = (text: string): string =>
		text
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s_-]/gu, '')
			.trim()
			.replace(/\s+/g, '-');

	{
		const previous = md.renderer.rules['heading_open'];
		const slugCounts = new WeakMap<Token[], Map<string, number>>();
		md.renderer.rules['heading_open'] = (tokens, idx, options, env, self) => {
			const inline = tokens[idx + 1];
			if (
				inline &&
				inline.type === 'inline' &&
				typeof inline.content === 'string'
			) {
				const base = slugify(inline.content);
				if (base) {
					let counts = slugCounts.get(tokens);
					if (!counts) {
						counts = new Map();
						slugCounts.set(tokens, counts);
					}
					const n = counts.get(base) ?? 0;
					counts.set(base, n + 1);
					const slug = n === 0 ? base : `${base}-${n}`;
					tokens[idx].attrJoin('id', slug);
				}
			}
			return previous
				? previous(tokens, idx, options, env, self)
				: self.renderToken(tokens, idx, options);
		};
	}

	{
		const previous = md.renderer.rules['math_block'];
		md.renderer.rules['math_block'] = (tokens, idx, options, env, self) => {
			const token = tokens[idx];
			const inner = previous
				? previous(tokens, idx, options, env, self)
				: self.renderToken(tokens, idx, options);
			if (!token.map) {
				return inner;
			}
			const startLine = token.map[0] + 1;
			const endLine = trimTrailingBlank(startLine, token.map[1], env);
			return `<div data-source-line="${startLine}" data-source-line-end="${endLine}">${inner}</div>`;
		};
	}

	return md;
}

const md = createMarkdownIt();

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let nonce = '';
	for (let i = 0; i < 32; i++) {
		nonce += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return nonce;
}

function buildHtml(
	webview: vscode.Webview,
	extensionUri: vscode.Uri,
	renderedBody: string,
): string {
	const nonce = getNonce();
	const cssUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'media', 'preview.css'),
	);
	const katexCssUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'node_modules', 'katex', 'dist', 'katex.min.css'),
	);
	const jsUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'media', 'preview.js'),
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
	<link rel="stylesheet" href="${cssUri}" />
	<title>Ask Markdown Preview</title>
</head>
<body>
	<div id="app">
		<div id="toolbar">
			<button id="toggle-source" title="Show Source">&lt;/&gt;</button>
			<div id="export-pdf-wrap">
				<button id="export-pdf" title="Export as PDF (choose &quot;Save as PDF&quot; in the print dialog)" aria-haspopup="menu" aria-expanded="false">PDF &#x25BE;</button>
				<div id="export-pdf-menu" role="menu" hidden>
					<button role="menuitem" data-pdf-style="clean">
						<span class="pdf-menu-title">Clean</span>
						<span class="pdf-menu-sub">White, minimal, printer-friendly</span>
					</button>
					<button role="menuitem" data-pdf-style="github">
						<span class="pdf-menu-title">GitHub</span>
						<span class="pdf-menu-sub">Sans-serif, subtle borders, README-style</span>
					</button>
					<button role="menuitem" data-pdf-style="academic">
						<span class="pdf-menu-title">Academic</span>
						<span class="pdf-menu-sub">Serif, off-white page, paper-like</span>
					</button>
					<button role="menuitem" data-pdf-style="theme">
						<span class="pdf-menu-title">Keep Theme</span>
						<span class="pdf-menu-sub">Export exactly what you see on screen</span>
					</button>
				</div>
			</div>
		</div>
		<div id="view-container">
			<div id="content-scroll">
				<article id="content">${renderedBody}</article>
			</div>
			<div id="source-view" style="display:none">
				<div id="line-numbers" aria-hidden="true"></div>
				<div id="source-highlight" aria-hidden="true"></div>
				<textarea id="source-editor" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off"></textarea>
			</div>
		</div>
	</div>
	<div id="ask-bar">
		<button data-action="claude">Add</button>
		<span class="ask-bar-sep"></span>
		<button data-action="edit">Inline Edit</button>
		<span class="ask-bar-sep"></span>
		<button data-action="translate">Translate</button>
		<span class="ask-bar-sep"></span>
		<button data-action="find">Find in source</button>
	</div>
	<div id="edit-bar">
		<input id="edit-input" type="text" placeholder='e.g. "make this a numbered list"' autocomplete="off" spellcheck="false" />
		<button id="edit-submit" type="button" title="Submit (Enter)">Edit</button>
		<button id="edit-cancel" type="button" title="Cancel (Esc)">&times;</button>
		<div id="edit-status" aria-live="polite">
			<span class="edit-thinking">
				<span class="edit-square"></span>
				<span class="edit-square"></span>
				<span class="edit-square"></span>
			</span>
			<span class="edit-status-text">Thinking\u2026</span>
		</div>
	</div>
	<div id="translate-bar">
		<div id="translate-header">
			<span class="translate-title">Translation <span id="translate-lang"></span></span>
			<button id="translate-close" type="button" title="Close (Esc)">&times;</button>
		</div>
		<div id="translate-status" aria-live="polite">
			<span class="edit-thinking">
				<span class="edit-square"></span>
				<span class="edit-square"></span>
				<span class="edit-square"></span>
			</span>
			<span class="translate-status-text">Thinking\u2026</span>
		</div>
		<div id="translate-content" aria-live="polite"></div>
	</div>
	<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

interface DictionaryPhonetic {
	text?: string;
	audio?: string;
}

interface DictionaryDefinition {
	definition?: string;
}

interface DictionaryMeaning {
	partOfSpeech?: string;
	definitions?: DictionaryDefinition[];
}

interface DictionaryEntry {
	word?: string;
	phonetic?: string;
	phonetics?: DictionaryPhonetic[];
	meanings?: DictionaryMeaning[];
}

function pickIPA(entry: DictionaryEntry): string {
	const phonetics = Array.isArray(entry.phonetics) ? entry.phonetics : [];
	// Prefer the variant with a US audio URL.
	for (const p of phonetics) {
		if (
			p &&
			typeof p.text === 'string' &&
			p.text &&
			typeof p.audio === 'string' &&
			/-us\.|_us\./i.test(p.audio)
		) {
			return p.text;
		}
	}
	// Fallback: any phonetic text.
	for (const p of phonetics) {
		if (p && typeof p.text === 'string' && p.text) {
			return p.text;
		}
	}
	return entry.phonetic ?? '';
}

function formatDictionaryEntry(data: unknown, word: string): string {
	const entries = Array.isArray(data) ? (data as DictionaryEntry[]) : [];
	if (entries.length === 0) {
		return `No entry found for "${word}".`;
	}

	let ipa = '';
	for (const entry of entries) {
		ipa = pickIPA(entry);
		if (ipa) {
			break;
		}
	}

	const lines: string[] = [];
	if (ipa) {
		lines.push(ipa);
		lines.push('');
	}

	for (const entry of entries) {
		const meanings = Array.isArray(entry.meanings) ? entry.meanings : [];
		for (const meaning of meanings) {
			const pos = meaning.partOfSpeech ?? '';
			const defs = Array.isArray(meaning.definitions)
				? meaning.definitions
				: [];
			let count = 0;
			for (const def of defs) {
				if (count >= 2) {
					break;
				}
				if (def && typeof def.definition === 'string' && def.definition) {
					lines.push(`${pos}: ${def.definition}`);
					count++;
				}
			}
		}
	}

	if (lines.length === 0 || (ipa && lines.length === 2)) {
		lines.push(`No definitions available for "${word}".`);
	}

	return lines.join('\n').trim();
}

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

async function exportPdf(
	document: vscode.TextDocument,
	style: string,
	extensionPath: string,
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
	const body = md.render(source, { source });
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

async function revealInSourceEditor(
	document: vscode.TextDocument,
	startLine: number,
	endLine: number,
): Promise<void> {
	await vscode.commands.executeCommand(
		'vscode.openWith',
		document.uri,
		'default',
		vscode.ViewColumn.Beside,
	);

	const editor = vscode.window.visibleTextEditors.find(
		(e) => e.document.uri.toString() === document.uri.toString(),
	);
	if (editor) {
		const range = toRange(document, startLine, endLine);
		editor.selection = new vscode.Selection(range.start, range.end);
		editor.revealRange(
			range,
			vscode.TextEditorRevealType.InCenterIfOutsideViewport,
		);
	}
}

export class AskMarkdownEditorProvider implements vscode.CustomTextEditorProvider {
	public static readonly viewType = 'askMarkdown.preview';

	constructor(private readonly context: vscode.ExtensionContext) {}

	public static register(context: vscode.ExtensionContext): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(
			AskMarkdownEditorProvider.viewType,
			new AskMarkdownEditorProvider(context),
			{
				webviewOptions: { retainContextWhenHidden: true },
				supportsMultipleEditorsPerDocument: false,
			},
		);
	}

	public async resolveCustomTextEditor(
		document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken,
	): Promise<void> {
		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.context.extensionUri, 'media'),
				vscode.Uri.joinPath(
					this.context.extensionUri,
					'node_modules',
					'katex',
					'dist',
				),
			],
		};

		const render = (): void => {
			const source = document.getText();
			const body = md.render(source, { source });
			webviewPanel.webview.html = buildHtml(
				webviewPanel.webview,
				this.context.extensionUri,
				body,
			);
		};

		render();

		// Send initial settings to the webview.
		const initConfig = vscode.workspace.getConfiguration('ask-markdown');
		webviewPanel.webview.postMessage({
			type: 'updateShowFloatingButton',
			enabled: initConfig.get<boolean>('showFloatingButton', true),
		});
		webviewPanel.webview.postMessage({
			type: 'updateTranslateEnabled',
			enabled: initConfig.get<boolean>('translateEnabled', true),
		});
		webviewPanel.webview.postMessage({
			type: 'updateSource',
			text: document.getText(),
		});
		let updateTimer: ReturnType<typeof setTimeout> | null = null;

		const changeSubscription = vscode.workspace.onDidChangeTextDocument(
			(e) => {
				if (e.document.uri.toString() === document.uri.toString()) {
					if (updateTimer) {
						clearTimeout(updateTimer);
					}
					updateTimer = setTimeout(() => {
						const text = document.getText();
						const body = md.render(text, { source: text });
						webviewPanel.webview.postMessage({
							type: 'updateContent',
							body,
						});
						webviewPanel.webview.postMessage({
							type: 'updateSource',
							text,
						});
					}, 150);
				}
			},
		);

		let scrollingFromPreview = false;
		let scrollGuardTimer: ReturnType<typeof setTimeout> | null = null;
		let inlineEditProc: ReturnType<typeof spawn> | null = null;
		let translateAbort: AbortController | null = null;

		const scrollSubscription =
			vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
				if (scrollingFromPreview) {
					return;
				}
				if (
					e.textEditor.document.uri.toString() ===
						document.uri.toString() &&
					e.visibleRanges.length > 0
				) {
					const topLine = e.visibleRanges[0].start.line + 1;
					webviewPanel.webview.postMessage({
						type: 'scrollTo',
						line: topLine,
					});
				}
			});

		const messageSubscription = webviewPanel.webview.onDidReceiveMessage(
			async (message: { type: string; [key: string]: unknown }) => {
				if (message.type === 'revealSource') {
					const startLine = Math.max(0, Number(message.line) - 1);
					const endLine = message.endLine
						? Math.max(0, Number(message.endLine) - 1)
						: startLine;
					await revealInSourceEditor(document, startLine, endLine);
				} else if (message.type === 'askClaude') {
					const startLine = Number(message.startLine);
					const endLine = Number(message.endLine);
					if (!isConnected()) {
						vscode.window.showWarningMessage(
							'Ask Markdown: No Claude CLI connected. Run "claude" in a terminal first.',
						);
						return;
					}
					broadcast('at_mentioned', {
						filePath: document.uri.fsPath,
						lineStart: startLine,
						lineEnd: endLine,
					});
					vscode.commands.executeCommand('workbench.action.terminal.focus');
				} else if (message.type === 'syncSelection') {
					const startLine = Math.max(
						0,
						Number(message.startLine) - 1,
					);
					const endLine = Math.max(0, Number(message.endLine) - 1);
					const range = toRange(document, startLine, endLine);
					const editor = vscode.window.visibleTextEditors.find(
						(e) =>
							e.document.uri.toString() ===
							document.uri.toString(),
					);
					if (editor) {
						editor.selection = new vscode.Selection(
							range.start,
							range.end,
						);
						editor.revealRange(
							range,
							vscode.TextEditorRevealType
								.InCenterIfOutsideViewport,
						);
					}
					const selectedText =
						(message.text as string | undefined) ??
						document.getText(range);
					const selectionPayload = {
						text: selectedText,
						filePath: document.uri.fsPath,
						fileUrl: document.uri.toString(),
						selection: {
							start: {
								line: range.start.line,
								character: range.start.character,
							},
							end: {
								line: range.end.line,
								character: range.end.character,
							},
							isEmpty: false,
						},
					};
					updateLatestSelection(selectionPayload);
					if (isConnected()) {
						broadcast('selection_changed', selectionPayload);
					}
				} else if (message.type === 'previewSelectionCleared') {
					if (isConnected()) {
						broadcast('selection_changed', {
							text: '',
							filePath: document.uri.fsPath,
							fileUrl: document.uri.toString(),
							selection: {
								start: { line: 0, character: 0 },
								end: { line: 0, character: 0 },
								isEmpty: true,
							},
						});
					}
				} else if (message.type === 'scrollFromPreview') {
					const line = Math.max(0, Number(message.line) - 1);
					scrollingFromPreview = true;
					if (scrollGuardTimer) {
						clearTimeout(scrollGuardTimer);
					}
					scrollGuardTimer = setTimeout(() => {
						scrollingFromPreview = false;
					}, 100);
					const editor = vscode.window.visibleTextEditors.find(
						(e) =>
							e.document.uri.toString() ===
							document.uri.toString(),
					);
					if (editor) {
						const pos = new vscode.Position(line, 0);
						editor.revealRange(
							new vscode.Range(pos, pos),
							vscode.TextEditorRevealType.AtTop,
						);
					}
				} else if (message.type === 'editSource') {
					const newText = message.text as string;
					const fullRange = new vscode.Range(
						document.positionAt(0),
						document.positionAt(document.getText().length),
					);
					const edit = new vscode.WorkspaceEdit();
					edit.replace(document.uri, fullRange, newText);
					await vscode.workspace.applyEdit(edit);
				} else if (message.type === 'inlineEdit') {
					if (inlineEditProc) {
						inlineEditProc.kill();
						inlineEditProc = null;
					}

					const startLine = Number(message.startLine);
					const endLine = Number(message.endLine);
					const selectedText = message.text as string;
					const instruction =
						typeof message.instruction === 'string'
							? message.instruction.trim()
							: '';

					if (!instruction) {
						webviewPanel.webview.postMessage({
							type: 'inlineEditError',
							error: 'Empty instruction',
						});
						return;
					}

					// Write the current in-memory document content to a
					// scratch file we own. Claude edits that copy; we apply
					// the result back to the real document via WorkspaceEdit
					// so the change goes through VS Code's normal text edit
					// pipeline (undo-able, no file watcher dependency, works
					// even when the document has unsaved changes).
					const baseName = path.basename(document.uri.fsPath) || 'doc.md';
					const safeBase = baseName.replace(/[^a-zA-Z0-9._-]/g, '_');
					const tempPath = path.join(
						os.tmpdir(),
						`ask-markdown-edit-${Date.now()}-${safeBase}`,
					);
					try {
						fs.writeFileSync(tempPath, document.getText(), 'utf8');
					} catch (err) {
						webviewPanel.webview.postMessage({
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
					inlineEditProc = proc;

					const errChunks: Buffer[] = [];
					// Keep the tail of stdout so we can surface Claude's own
					// complaint when exit is non-zero and stderr is empty.
					const stdoutTailLimit = 4096;
					let stdoutTail = '';

					proc.stdout!.on('data', (data: Buffer) => {
						stdoutTail = (stdoutTail + data.toString()).slice(
							-stdoutTailLimit,
						);
					});
					proc.stderr!.on('data', (data: Buffer) => {
						errChunks.push(data);
					});

					proc.on('close', async (code, signal) => {
						if (inlineEditProc !== proc) {
							return;
						}
						inlineEditProc = null;
						if (signal === 'SIGTERM' || signal === 'SIGKILL') {
							cleanup();
							webviewPanel.webview.postMessage({
								type: 'inlineEditDone',
							});
							return;
						}
						if (code !== 0) {
							const stderr = Buffer.concat(errChunks)
								.toString()
								.trim();
							const detail = stderr || stdoutTail.trim();
							cleanup();
							webviewPanel.webview.postMessage({
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
							webviewPanel.webview.postMessage({
								type: 'inlineEditDone',
							});
						} catch (err) {
							webviewPanel.webview.postMessage({
								type: 'inlineEditError',
								error: `Failed to apply edit: ${(err as Error).message}`,
							});
						} finally {
							cleanup();
						}
					});

					proc.on('error', (err) => {
						if (inlineEditProc !== proc) {
							return;
						}
						inlineEditProc = null;
						cleanup();
						webviewPanel.webview.postMessage({
							type: 'inlineEditError',
							error: `Failed to run claude: ${err.message}`,
						});
					});

					proc.stdin!.write(prompt);
					proc.stdin!.end();
				} else if (message.type === 'inlineEditCancel') {
					if (inlineEditProc) {
						inlineEditProc.kill();
						inlineEditProc = null;
					}
				} else if (message.type === 'translate') {
					if (translateAbort) {
						translateAbort.abort();
						translateAbort = null;
					}

					const selectedText = (message.text as string) || '';
					const wordMatch = selectedText.match(/[a-zA-Z][a-zA-Z'-]*/);
					const word = wordMatch ? wordMatch[0].toLowerCase() : '';

					if (!word) {
						webviewPanel.webview.postMessage({
							type: 'translateError',
							error: 'Select an English word to look up.',
						});
						return;
					}

					const url =
						'https://api.dictionaryapi.dev/api/v2/entries/en/' +
						encodeURIComponent(word);
					const controller = new AbortController();
					translateAbort = controller;

					const req = https.get(
						url,
						{ signal: controller.signal },
						(res) => {
							const chunks: Buffer[] = [];
							res.on('data', (chunk: Buffer) => chunks.push(chunk));
							res.on('end', () => {
								if (translateAbort !== controller) {
									return;
								}
								translateAbort = null;

								if (res.statusCode === 404) {
									webviewPanel.webview.postMessage({
										type: 'translateError',
										error: `"${word}" not found in dictionary.`,
									});
									return;
								}
								if (res.statusCode !== 200) {
									webviewPanel.webview.postMessage({
										type: 'translateError',
										error: `Lookup failed (HTTP ${res.statusCode ?? '?'}).`,
									});
									return;
								}

								try {
									const data = JSON.parse(
										Buffer.concat(chunks).toString(),
									);
									const formatted = formatDictionaryEntry(
										data,
										word,
									);
									webviewPanel.webview.postMessage({
										type: 'translateResult',
										result: formatted,
										language: 'en',
										streaming: false,
									});
								} catch (err) {
									webviewPanel.webview.postMessage({
										type: 'translateError',
										error: `Failed to parse response: ${(err as Error).message}`,
									});
								}
							});
						},
					);
					req.on('error', (err) => {
						if (translateAbort !== controller) {
							return;
						}
						translateAbort = null;
						if ((err as NodeJS.ErrnoException).code === 'ABORT_ERR') {
							return;
						}
						webviewPanel.webview.postMessage({
							type: 'translateError',
							error: `Network error: ${err.message}`,
						});
					});
				} else if (message.type === 'translateCancel') {
					if (translateAbort) {
						translateAbort.abort();
						translateAbort = null;
					}
				} else if (message.type === 'openLink') {
					const href =
						typeof message.href === 'string' ? message.href : '';
					if (!href) {
						return;
					}
					let target: vscode.Uri | undefined;
					try {
						target = vscode.Uri.parse(href, true);
					} catch {
						target = undefined;
					}
					if (!target || !target.scheme) {
						// Relative path — resolve against the document's directory.
						const docDir = vscode.Uri.joinPath(document.uri, '..');
						target = vscode.Uri.joinPath(docDir, href);
					}
					if (
						target.scheme === 'file' &&
						target.path.toLowerCase().endsWith('.md')
					) {
						await vscode.commands.executeCommand(
							'vscode.openWith',
							target,
							AskMarkdownEditorProvider.viewType,
						);
					} else {
						await vscode.env.openExternal(target);
					}
				} else if (message.type === 'exportPdf') {
					const style =
						typeof message.style === 'string' ? message.style : 'clean';
					await exportPdf(document, style, this.context.extensionPath);
				}
			},
		);

		const configSubscription = vscode.workspace.onDidChangeConfiguration(
			(e) => {
				const cfg = vscode.workspace.getConfiguration('ask-markdown');
				if (e.affectsConfiguration('ask-markdown.showFloatingButton')) {
					webviewPanel.webview.postMessage({
						type: 'updateShowFloatingButton',
						enabled: cfg.get<boolean>('showFloatingButton', true),
					});
				}
				if (e.affectsConfiguration('ask-markdown.translateEnabled')) {
					webviewPanel.webview.postMessage({
						type: 'updateTranslateEnabled',
						enabled: cfg.get<boolean>('translateEnabled', true),
					});
				}
			},
		);

		webviewPanel.onDidDispose(() => {
			changeSubscription.dispose();
			scrollSubscription.dispose();
			messageSubscription.dispose();
			configSubscription.dispose();
			if (inlineEditProc) {
				inlineEditProc.kill();
				inlineEditProc = null;
			}
			if (translateAbort) {
				translateAbort.abort();
				translateAbort = null;
			}
		});
	}
}
