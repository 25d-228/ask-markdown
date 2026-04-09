// Runs inside the Ask Markdown webview.
// On any text selection inside a block tagged with `data-source-line`,
// post a message to the extension host containing the selected text and
// the source line range.

(function () {
	const vscode = acquireVsCodeApi();

	/**
	 * Walk up from `node` to the nearest Element that carries a
	 * `data-source-line` attribute. Returns null if none is found.
	 */
	function findSourceElement(node) {
		let el = node;
		if (el && el.nodeType !== 1) {
			el = el.parentElement;
		}
		while (el && !(el.dataset && el.dataset.sourceLine)) {
			el = el.parentElement;
		}
		return el || null;
	}

	function handleSelection() {
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed) {
			return;
		}
		const text = sel.toString();
		if (!text.trim()) {
			return;
		}

		const startEl = findSourceElement(sel.anchorNode);
		const endEl = findSourceElement(sel.focusNode);
		if (!startEl && !endEl) {
			return;
		}

		// Use whichever endpoints we have; if only one is mappable, fall back to it.
		const a = startEl || endEl;
		const b = endEl || startEl;

		const aStart = Number(a.dataset.sourceLine);
		const aEnd = Number(a.dataset.sourceLineEnd || a.dataset.sourceLine);
		const bStart = Number(b.dataset.sourceLine);
		const bEnd = Number(b.dataset.sourceLineEnd || b.dataset.sourceLine);

		const startLine = Math.min(aStart, bStart);
		const endLine = Math.max(aEnd, bEnd);

		vscode.postMessage({
			type: 'askAboutSelection',
			text,
			startLine,
			endLine,
		});
	}

	document.addEventListener('mouseup', handleSelection);
	document.addEventListener('keyup', (e) => {
		// Capture keyboard-driven selections (Shift+Arrow, etc).
		if (e.shiftKey || e.key === 'Shift') {
			handleSelection();
		}
	});
})();
