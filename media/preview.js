// Runs inside the Ask Markdown webview.
// Handles: text selection → extension host, floating action bar,
// click-to-jump, and scroll sync from the host.

(function () {
	const vscode = acquireVsCodeApi();

	// ── Helpers ──

	/** Walk up to the nearest element with `data-source-line`. */
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

	/** Compute {startLine, endLine} from the current selection endpoints. */
	function selectionLineRange() {
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed) {
			return null;
		}
		const text = sel.toString();
		if (!text.trim()) {
			return null;
		}

		const startEl = findSourceElement(sel.anchorNode);
		const endEl = findSourceElement(sel.focusNode);
		if (!startEl && !endEl) {
			return null;
		}

		const a = startEl || endEl;
		const b = endEl || startEl;

		const aStart = Number(a.dataset.sourceLine);
		const aEnd = Number(a.dataset.sourceLineEnd || a.dataset.sourceLine);
		const bStart = Number(b.dataset.sourceLine);
		const bEnd = Number(b.dataset.sourceLineEnd || b.dataset.sourceLine);

		return {
			text,
			startLine: Math.min(aStart, bStart),
			endLine: Math.max(aEnd, bEnd),
		};
	}

	// ── Toggle source button (fixed top-right) ──

	const toggleBtn = document.createElement('button');
	toggleBtn.id = 'toggle-source';
	toggleBtn.textContent = '</>';
	toggleBtn.title = 'Show Source';
	document.body.appendChild(toggleBtn);

	toggleBtn.addEventListener('click', function () {
		vscode.postMessage({ type: 'toggleSource' });
	});

	// ── Floating action bar ──

	const bar = document.createElement('div');
	bar.id = 'ask-bar';
	bar.innerHTML =
		'<button data-action="claude">Claude</button>' +
		'<span class="ask-bar-sep"></span>' +
		'<button data-action="codex">Codex</button>' +
		'<span class="ask-bar-sep"></span>' +
		'<button data-action="find">Find in source</button>';
	document.body.appendChild(bar);

	let currentRange = null;

	function showBar() {
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed || !sel.rangeCount) {
			hideBar();
			return;
		}

		currentRange = selectionLineRange();
		if (!currentRange) {
			hideBar();
			return;
		}

		// Sync selection to the source editor (focus stays in webview).
		vscode.postMessage({
			type: 'syncSelection',
			startLine: currentRange.startLine,
			endLine: currentRange.endLine,
		});

		const rect = sel.getRangeAt(0).getBoundingClientRect();
		bar.style.display = 'block';
		bar.style.left = Math.max(0, rect.left + (rect.width - bar.offsetWidth) / 2) + 'px';
		bar.style.top = (rect.top + window.scrollY - bar.offsetHeight - 6) + 'px';
	}

	function hideBar() {
		bar.style.display = 'none';
		currentRange = null;
	}

	bar.addEventListener('click', function (e) {
		const btn = e.target.closest('button');
		if (!btn || !currentRange) {
			return;
		}
		const action = btn.dataset.action;
		if (action === 'claude') {
			vscode.postMessage({
				type: 'askClaude',
				startLine: currentRange.startLine,
				endLine: currentRange.endLine,
			});
		} else if (action === 'codex') {
			vscode.postMessage({
				type: 'askCodex',
				startLine: currentRange.startLine,
				endLine: currentRange.endLine,
			});
		} else if (action === 'find') {
			vscode.postMessage({
				type: 'revealSource',
				line: currentRange.startLine,
				endLine: currentRange.endLine,
			});
		}
		hideBar();
	});

	// Show bar on selection with a small debounce.
	let selTimer = null;
	document.addEventListener('selectionchange', function () {
		clearTimeout(selTimer);
		selTimer = setTimeout(function () {
			const sel = window.getSelection();
			if (!sel || sel.isCollapsed) {
				hideBar();
			} else {
				showBar();
			}
		}, 200);
	});

	// Also fire on mouseup for snappier feedback.
	document.addEventListener('mouseup', function (e) {
		// Ignore clicks on the bar itself and toggle button.
		if (bar.contains(e.target) || toggleBtn.contains(e.target)) {
			return;
		}
		clearTimeout(selTimer);
		setTimeout(showBar, 50);
	});

	// ── Double-click-to-jump ──

	document.addEventListener('dblclick', function (e) {
		if (bar.contains(e.target)) {
			return;
		}
		const el = findSourceElement(e.target);
		if (!el) {
			return;
		}
		vscode.postMessage({
			type: 'revealSource',
			line: Number(el.dataset.sourceLine),
			endLine: Number(el.dataset.sourceLineEnd || el.dataset.sourceLine),
		});
	});

	// ── Scroll sync (host → webview) ──

	window.addEventListener('message', function (e) {
		const msg = e.data;
		if (msg.type === 'scrollTo') {
			const line = msg.line;
			const all = document.querySelectorAll('[data-source-line]');
			let best = null;
			let bestDist = Infinity;
			for (let i = 0; i < all.length; i++) {
				const el = all[i];
				const l = Number(el.dataset.sourceLine);
				const dist = Math.abs(l - line);
				if (dist < bestDist) {
					bestDist = dist;
					best = el;
				}
			}
			if (best) {
				best.scrollIntoView({ behavior: 'smooth', block: 'center' });
			}
		} else if (msg.type === 'updateShowFloatingButton') {
			bar.style.display = 'none';
			bar.dataset.enabled = msg.enabled ? 'true' : 'false';
		}
	});
})();
