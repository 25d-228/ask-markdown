import * as vscode from 'vscode';

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let nonce = '';
	for (let i = 0; i < 32; i++) {
		nonce += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return nonce;
}

export function buildPreviewHtml(
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
			<div id="search-wrap">
				<input id="search-input" type="text" placeholder="Search" autocomplete="off" spellcheck="false" />
				<span id="search-count" aria-live="polite"></span>
				<button id="search-prev" type="button" title="Previous (Shift+Enter)" disabled>&uarr;</button>
				<button id="search-next" type="button" title="Next (Enter)" disabled>&darr;</button>
				<button id="search-clear" type="button" title="Clear (Esc)">&times;</button>
			</div>
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
				<div id="source-search-overlay" aria-hidden="true"></div>
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
			<span class="edit-status-text">Thinking…</span>
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
			<span class="translate-status-text">Thinking…</span>
		</div>
		<div id="translate-content" aria-live="polite"></div>
	</div>
	<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}
