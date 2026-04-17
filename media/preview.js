// Runs inside the Ask Markdown webview.
// Handles: preview ↔ source toggle, syntax-highlighted editable source,
// line numbers, text selection, floating action bar, click-to-jump,
// scroll sync, and scroll history tracking.

(function () {
	var vscode = acquireVsCodeApi();

	// ── State ──

	var mode = 'preview'; // 'preview' | 'source'
	var rawSource = '';
	var textareaEditing = false;
	var textareaEditTimer = null;
	var editTimer = null;

	// Scroll history: remember last scrollTop for each view
	var previewScrollTop = 0;
	var sourceScrollTop = 0;

	// ── DOM refs (pre-built in HTML) ──

	var contentScroll = document.getElementById('content-scroll');
	var contentEl = document.getElementById('content');
	var sourceView = document.getElementById('source-view');
	var lineNumbers = document.getElementById('line-numbers');
	var sourceHighlight = document.getElementById('source-highlight');
	var sourceTextarea = document.getElementById('source-editor');
	var toolbar = document.getElementById('toolbar');
	var editBtn = document.getElementById('edit-btn');
	var toggleBtn = document.getElementById('toggle-source');
	var bar = document.getElementById('ask-bar');
	var findBtn = bar.querySelector('[data-action="find"]');
	var editBar = document.getElementById('edit-bar');
	var editInput = document.getElementById('edit-input');
	var editSubmit = document.getElementById('edit-submit');
	var editCancel = document.getElementById('edit-cancel');
	var editStatusText = editBar
		? editBar.querySelector('.edit-status-text')
		: null;
	var translateBar = document.getElementById('translate-bar');
	var translateClose = document.getElementById('translate-close');
	var translateLang = document.getElementById('translate-lang');
	var translateContent = document.getElementById('translate-content');
	var translateStatusText = translateBar
		? translateBar.querySelector('.translate-status-text')
		: null;

	// ── Line numbers ──

	function updateLineNumbers() {
		var count = sourceTextarea.value.split('\n').length;
		var digits = String(count).length;
		var gutterWidth = (digits * 0.65 + 1.2) + 'em';
		sourceView.style.setProperty('--gutter-width', gutterWidth);

		var nums = '';
		for (var i = 1; i <= count; i++) {
			nums += i + '\n';
		}
		lineNumbers.textContent = nums;
	}

	function syncGutterScroll() {
		lineNumbers.scrollTop = sourceTextarea.scrollTop;
	}

	// ── Syntax highlight rendering ──

	function escapeHtml(str) {
		return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	function highlightLine(line) {
		// Headings
		if (/^#{1,6}\s/.test(line)) {
			return '<span class="md-heading">' + escapeHtml(line) + '</span>';
		}
		// Horizontal rule
		if (/^(\*\*\*|---|___)\s*$/.test(line)) {
			return '<span class="md-hr">' + escapeHtml(line) + '</span>';
		}
		// Blockquote
		if (/^>\s?/.test(line)) {
			return '<span class="md-blockquote">' + escapeHtml(line) + '</span>';
		}
		// Unordered list bullet
		if (/^\s*[-*+]\s/.test(line)) {
			var m = line.match(/^(\s*[-*+]\s)/);
			return '<span class="md-bullet">' + escapeHtml(m[1]) + '</span>' + highlightInline(line.substring(m[1].length));
		}
		// Ordered list
		if (/^\s*\d+\.\s/.test(line)) {
			var m2 = line.match(/^(\s*\d+\.\s)/);
			return '<span class="md-bullet">' + escapeHtml(m2[1]) + '</span>' + highlightInline(line.substring(m2[1].length));
		}
		return highlightInline(line);
	}

	function highlightInline(text) {
		var result = '';
		var i = 0;
		while (i < text.length) {
			// Inline code
			if (text[i] === '`') {
				var end = text.indexOf('`', i + 1);
				if (end !== -1) {
					result += '<span class="md-inline-code">' + escapeHtml(text.substring(i, end + 1)) + '</span>';
					i = end + 1;
					continue;
				}
			}
			// Image ![alt](url)
			if (text[i] === '!' && text[i + 1] === '[') {
				var closeBracket = text.indexOf(']', i + 2);
				if (closeBracket !== -1 && text[closeBracket + 1] === '(') {
					var closeParen = text.indexOf(')', closeBracket + 2);
					if (closeParen !== -1) {
						result += '<span class="md-image">' + escapeHtml(text.substring(i, closeParen + 1)) + '</span>';
						i = closeParen + 1;
						continue;
					}
				}
			}
			// Link [text](url)
			if (text[i] === '[') {
				var closeBracket2 = text.indexOf(']', i + 1);
				if (closeBracket2 !== -1 && text[closeBracket2 + 1] === '(') {
					var closeParen2 = text.indexOf(')', closeBracket2 + 2);
					if (closeParen2 !== -1) {
						result += '<span class="md-link">' + escapeHtml(text.substring(i, closeParen2 + 1)) + '</span>';
						i = closeParen2 + 1;
						continue;
					}
				}
			}
			// Bold **text** or __text__
			if ((text[i] === '*' && text[i + 1] === '*') || (text[i] === '_' && text[i + 1] === '_')) {
				var marker = text.substring(i, i + 2);
				var end2 = text.indexOf(marker, i + 2);
				if (end2 !== -1) {
					result += '<span class="md-bold">' + escapeHtml(text.substring(i, end2 + 2)) + '</span>';
					i = end2 + 2;
					continue;
				}
			}
			// Italic *text* or _text_ (single)
			if ((text[i] === '*' || text[i] === '_') && i + 1 < text.length && text[i + 1] !== text[i]) {
				var marker2 = text[i];
				var end3 = text.indexOf(marker2, i + 1);
				if (end3 !== -1 && end3 > i + 1) {
					result += '<span class="md-italic">' + escapeHtml(text.substring(i, end3 + 1)) + '</span>';
					i = end3 + 1;
					continue;
				}
			}
			result += escapeHtml(text[i]);
			i++;
		}
		return result;
	}

	function renderHighlight(text) {
		var lines = text.split('\n');
		var html = '';
		var inFence = false;

		for (var i = 0; i < lines.length; i++) {
			var line = lines[i];

			if (/^```/.test(line)) {
				if (!inFence) {
					inFence = true;
					html += '<span class="md-fence">' + escapeHtml(line) + '</span>';
				} else {
					inFence = false;
					html += '<span class="md-fence">' + escapeHtml(line) + '</span>';
				}
			} else if (inFence) {
				html += '<span class="md-code-content">' + escapeHtml(line) + '</span>';
			} else {
				html += highlightLine(line);
			}

			if (i < lines.length - 1) {
				html += '\n';
			}
		}

		// Must end with a newline so the highlight div matches the textarea height
		if (text.length > 0 && text[text.length - 1] === '\n') {
			html += '\n';
		}

		return html;
	}

	function updateHighlight() {
		sourceHighlight.innerHTML = renderHighlight(sourceTextarea.value);
	}

	// ── Helpers ──

	/** Walk up to the nearest element with `data-source-line`. */
	function findSourceElement(node) {
		var el = node;
		if (el && el.nodeType !== 1) {
			el = el.parentElement;
		}
		while (el && !(el.dataset && el.dataset.sourceLine)) {
			el = el.parentElement;
		}
		return el || null;
	}

	/** Selection range from preview mode (DOM-based). */
	function previewSelectionRange() {
		var sel = window.getSelection();
		if (!sel || sel.isCollapsed) {
			return null;
		}
		var text = sel.toString();
		if (!text.trim()) {
			return null;
		}

		var startEl = findSourceElement(sel.anchorNode);
		var endEl = findSourceElement(sel.focusNode);
		if (!startEl && !endEl) {
			return null;
		}

		var a = startEl || endEl;
		var b = endEl || startEl;
		var aStart = Number(a.dataset.sourceLine);
		var aEnd = Number(a.dataset.sourceLineEnd || a.dataset.sourceLine);
		var bStart = Number(b.dataset.sourceLine);
		var bEnd = Number(b.dataset.sourceLineEnd || b.dataset.sourceLine);

		return {
			text: text,
			startLine: Math.min(aStart, bStart),
			endLine: Math.max(aEnd, bEnd),
		};
	}

	/** Selection range from source mode (textarea-based). */
	function sourceSelectionRange() {
		var start = sourceTextarea.selectionStart;
		var end = sourceTextarea.selectionEnd;
		if (start === end) {
			return null;
		}

		var text = sourceTextarea.value;
		var selected = text.substring(start, end);
		if (!selected.trim()) {
			return null;
		}

		var startLine = text.substring(0, start).split('\n').length;
		var endLine = text.substring(0, end).split('\n').length;

		return {
			text: selected,
			startLine: startLine,
			endLine: endLine,
		};
	}

	function selectionLineRange() {
		return mode === 'source' ? sourceSelectionRange() : previewSelectionRange();
	}

	/** Select lines startLine..endLine in the textarea (no focus/scroll side-effects). */
	function selectInTextarea(startLine, endLine) {
		var text = sourceTextarea.value;
		var lines = text.split('\n');
		startLine = Math.max(1, startLine | 0);
		endLine = Math.max(startLine, endLine | 0);
		var startPos = 0;
		for (var i = 0; i < Math.min(startLine - 1, lines.length); i++) {
			startPos += lines[i].length + 1;
		}
		var endPos = startPos;
		for (
			var j = startLine - 1;
			j < Math.min(endLine, lines.length);
			j++
		) {
			endPos += lines[j].length + 1;
		}
		if (endPos > startPos) {
			endPos--; // exclude trailing newline
		}
		sourceTextarea.focus();
		sourceTextarea.setSelectionRange(startPos, endPos);
	}

	/** Select matching elements in preview by line range. */
	function selectInPreview(startLine, endLine) {
		var all = contentEl.querySelectorAll('[data-source-line]');
		var firstEl = null;
		var lastEl = null;
		for (var i = 0; i < all.length; i++) {
			var elStart = Number(all[i].dataset.sourceLine);
			var elEnd = Number(all[i].dataset.sourceLineEnd || elStart);
			if (elStart <= endLine && elEnd >= startLine) {
				if (!firstEl) {
					firstEl = all[i];
				}
				lastEl = all[i];
			}
		}
		if (!firstEl || !lastEl) {
			return;
		}
		var range = document.createRange();
		range.setStartBefore(firstEl);
		range.setEndAfter(lastEl);
		var sel = window.getSelection();
		sel.removeAllRanges();
		sel.addRange(range);
	}

	// ── Source editing ──

	sourceTextarea.addEventListener('input', function () {
		textareaEditing = true;
		if (textareaEditTimer) {
			clearTimeout(textareaEditTimer);
		}
		textareaEditTimer = setTimeout(function () {
			textareaEditing = false;
		}, 500);
		rawSource = sourceTextarea.value;
		updateHighlight();
		updateLineNumbers();

		if (editTimer) {
			clearTimeout(editTimer);
		}
		editTimer = setTimeout(function () {
			editTimer = null;
			vscode.postMessage({ type: 'editSource', text: sourceTextarea.value });
		}, 150);
	});

	// Sync scroll between textarea, highlight div, and line numbers
	sourceTextarea.addEventListener('scroll', function () {
		sourceHighlight.scrollTop = sourceTextarea.scrollTop;
		sourceHighlight.scrollLeft = sourceTextarea.scrollLeft;
		syncGutterScroll();
	});

	// Handle Tab key: insert tab character instead of moving focus.
	sourceTextarea.addEventListener('keydown', function (e) {
		if (e.key === 'Tab') {
			e.preventDefault();
			var start = sourceTextarea.selectionStart;
			var end = sourceTextarea.selectionEnd;
			var val = sourceTextarea.value;
			sourceTextarea.value =
				val.substring(0, start) + '\t' + val.substring(end);
			sourceTextarea.selectionStart = sourceTextarea.selectionEnd =
				start + 1;
			sourceTextarea.dispatchEvent(new Event('input'));
		}
	});

	// ── Smart scroll ──

	function smartScroll(scrollContainer, targetTop) {
		var current = scrollContainer.scrollTop;
		var viewH = scrollContainer.clientHeight;
		var distance = Math.abs(targetTop - current);

		if (distance > viewH * 3) {
			scrollContainer.scrollTop = targetTop;
		} else {
			scrollContainer.scrollTo({ top: targetTop, behavior: 'smooth' });
		}
	}

	// ── Mode switching ──

	function topVisibleLine() {
		if (mode === 'source') {
			var lh =
				parseFloat(getComputedStyle(sourceTextarea).lineHeight) || 20;
			return Math.floor(sourceTextarea.scrollTop / lh) + 1;
		}
		var all = contentEl.querySelectorAll('[data-source-line]');
		var best = null;
		for (var i = 0; i < all.length; i++) {
			var rect = all[i].getBoundingClientRect();
			if (rect.top >= 0) {
				return Number(all[i].dataset.sourceLine);
			}
			best = Number(all[i].dataset.sourceLine);
		}
		return best;
	}

	function flushPendingEdit() {
		if (editTimer) {
			clearTimeout(editTimer);
			editTimer = null;
			vscode.postMessage({ type: 'editSource', text: sourceTextarea.value });
		}
	}

	function scrollTextareaToLine(line, center) {
		var lh =
			parseFloat(getComputedStyle(sourceTextarea).lineHeight) || 20;
		var targetTop = (line - 1) * lh;
		if (center) {
			targetTop -= sourceTextarea.clientHeight / 2;
		}
		targetTop = Math.max(0, targetTop);
		smartScroll(sourceTextarea, targetTop);
		// Sync after setting scrollTop (for instant jumps)
		sourceHighlight.scrollTop = sourceTextarea.scrollTop;
		syncGutterScroll();
	}

	function switchToSource(scrollToLine, center, selectRange) {
		flushPendingEdit();
		// Save current preview scroll position
		previewScrollTop = contentScroll.scrollTop;

		mode = 'source';
		contentScroll.style.display = 'none';
		sourceView.style.display = 'block';
		sourceTextarea.value = rawSource;
		updateHighlight();
		updateLineNumbers();
		toggleBtn.title = 'Show Preview';
		toggleBtn.classList.add('active');
		updateBarLabels();
		hideBar();

		if (scrollToLine) {
			// Use requestAnimationFrame to ensure layout is computed
			// after display:block, then select first, then scroll.
			// The scroll MUST come after selection to override the
			// browser's auto-scroll triggered by setSelectionRange/focus.
			requestAnimationFrame(function () {
				if (selectRange) {
					selectInTextarea(selectRange.startLine, selectRange.endLine);
				}
				// Scroll after selection so we control final position
				scrollTextareaToLine(scrollToLine, center);
			});
		} else {
			// Restore saved scroll position
			requestAnimationFrame(function () {
				sourceTextarea.scrollTop = sourceScrollTop;
				sourceHighlight.scrollTop = sourceScrollTop;
				syncGutterScroll();
			});
		}
	}

	function switchToPreview(scrollToLine, center, selectRange) {
		flushPendingEdit();
		// Save current source scroll position
		sourceScrollTop = sourceTextarea.scrollTop;

		mode = 'preview';
		sourceView.style.display = 'none';
		contentScroll.style.display = 'block';
		toggleBtn.title = 'Show Source';
		toggleBtn.classList.remove('active');
		updateBarLabels();
		hideBar();

		if (scrollToLine) {
			requestAnimationFrame(function () {
				var all = contentEl.querySelectorAll('[data-source-line]');
				var best = null;
				var bestDist = Infinity;
				for (var i = 0; i < all.length; i++) {
					var l = Number(all[i].dataset.sourceLine);
					var dist = Math.abs(l - scrollToLine);
					if (dist < bestDist) {
						bestDist = dist;
						best = all[i];
					}
				}
				if (best) {
					var elTop = best.offsetTop;
					if (center) {
						elTop -= contentScroll.clientHeight / 2;
					}
					smartScroll(contentScroll, Math.max(0, elTop));
				}
				if (selectRange) {
					selectInPreview(selectRange.startLine, selectRange.endLine);
				}
			});
		} else {
			// Restore saved scroll position
			requestAnimationFrame(function () {
				contentScroll.scrollTop = previewScrollTop;
			});
		}
	}

	// ── Toolbar events ──

	editBtn.addEventListener('click', function () {
		flushPendingEdit();
		vscode.postMessage({ type: 'openExternalEditor' });
	});

	toggleBtn.addEventListener('click', function () {
		var line = topVisibleLine();
		if (mode === 'preview') {
			switchToSource(line, false);
		} else {
			switchToPreview(line, false);
		}
	});

	// ── Floating action bar ──

	function updateBarLabels() {
		findBtn.textContent =
			mode === 'preview' ? 'Find in source' : 'Find in preview';
	}

	var currentRange = null;
	var lastMouseX = 0;
	var lastMouseY = 0;

	document.addEventListener('mousemove', function (e) {
		lastMouseX = e.clientX;
		lastMouseY = e.clientY;
	});

	function showBar() {
		if (bar.dataset.enabled === 'false') {
			return;
		}

		currentRange = selectionLineRange();
		if (!currentRange) {
			hideBar();
			return;
		}

		// Sync selection to the extension host.
		vscode.postMessage({
			type: 'syncSelection',
			text: currentRange.text,
			startLine: currentRange.startLine,
			endLine: currentRange.endLine,
		});

		bar.style.display = 'block';

		if (mode === 'source') {
			bar.style.left =
				Math.max(0, lastMouseX - bar.offsetWidth / 2) + 'px';
			bar.style.top =
				Math.max(0, lastMouseY - bar.offsetHeight - 10) + 'px';
		} else {
			var sel = window.getSelection();
			if (!sel || !sel.rangeCount) {
				hideBar();
				return;
			}
			var rect = sel.getRangeAt(0).getBoundingClientRect();
			bar.style.left =
				Math.max(0, rect.left + (rect.width - bar.offsetWidth) / 2) +
				'px';
			bar.style.top =
				rect.top - bar.offsetHeight - 6 + 'px';
		}
	}

	function hideBar() {
		bar.style.display = 'none';
		if (currentRange) {
			vscode.postMessage({ type: 'previewSelectionCleared' });
			currentRange = null;
		}
	}

	bar.addEventListener('click', function (e) {
		var btn = e.target.closest('button');
		if (!btn || !currentRange) {
			return;
		}
		var action = btn.dataset.action;
		if (action === 'claude') {
			vscode.postMessage({
				type: 'askClaude',
				startLine: currentRange.startLine,
				endLine: currentRange.endLine,
			});
		} else if (action === 'edit') {
			showEditBar(currentRange);
			return;
		} else if (action === 'translate') {
			showTranslateBar(currentRange);
			return;
		} else if (action === 'find') {
			var sel = {
				startLine: currentRange.startLine,
				endLine: currentRange.endLine,
			};
			if (mode === 'preview') {
				switchToSource(sel.startLine, true, sel);
			} else {
				switchToPreview(sel.startLine, true, sel);
			}
		}
		hideBar();
	});

	// ── Inline edit bar ──

	var editRange = null;

	function positionEditBar() {
		if (!editBar) {
			return;
		}
		var w = editBar.offsetWidth;
		var h = editBar.offsetHeight;
		var anchorLeft = lastMouseX;
		var anchorTop = lastMouseY;
		if (mode === 'preview') {
			var sel = window.getSelection();
			if (sel && sel.rangeCount) {
				var rect = sel.getRangeAt(0).getBoundingClientRect();
				if (rect.width || rect.height) {
					anchorLeft = rect.left + rect.width / 2;
					anchorTop = rect.top;
				}
			}
		}
		var left = Math.max(8, Math.min(window.innerWidth - w - 8, anchorLeft - w / 2));
		var top = anchorTop - h - 8;
		if (top < 8) {
			top = anchorTop + 16;
		}
		editBar.style.left = left + 'px';
		editBar.style.top = top + 'px';
	}

	function showEditBar(range) {
		if (!editBar || !range) {
			return;
		}
		editRange = {
			text: range.text,
			startLine: range.startLine,
			endLine: range.endLine,
		};
		bar.style.display = 'none';
		editBar.classList.remove('thinking');
		editBar.classList.remove('error');
		editBar.classList.add('visible');
		editInput.disabled = false;
		editSubmit.disabled = false;
		editCancel.disabled = false;
		editInput.value = '';
		if (editStatusText) {
			editStatusText.textContent = 'Thinking\u2026';
		}
		positionEditBar();
		// Re-position once the bar has actual dimensions.
		setTimeout(positionEditBar, 0);
		editInput.focus();
	}

	function hideEditBar() {
		if (!editBar) {
			return;
		}
		editBar.classList.remove('visible');
		editBar.classList.remove('thinking');
		editBar.classList.remove('error');
		if (editRange) {
			vscode.postMessage({ type: 'previewSelectionCleared' });
		}
		editRange = null;
	}

	function setEditThinking(on) {
		if (!editBar) {
			return;
		}
		if (on) {
			editBar.classList.add('thinking');
			editInput.disabled = true;
			editSubmit.disabled = true;
			if (editStatusText) {
				editStatusText.textContent = 'Thinking\u2026';
			}
		} else {
			editBar.classList.remove('thinking');
			editInput.disabled = false;
			editSubmit.disabled = false;
		}
	}

	function submitEdit() {
		if (!editRange) {
			return;
		}
		var instruction = editInput.value.trim();
		if (!instruction) {
			editInput.focus();
			return;
		}
		editBar.classList.remove('error');
		setEditThinking(true);
		vscode.postMessage({
			type: 'inlineEdit',
			startLine: editRange.startLine,
			endLine: editRange.endLine,
			text: editRange.text,
			instruction: instruction,
		});
	}

	function cancelEdit() {
		var wasThinking = editBar && editBar.classList.contains('thinking');
		if (wasThinking) {
			vscode.postMessage({ type: 'inlineEditCancel' });
		}
		hideEditBar();
	}

	if (editBar) {
		editSubmit.addEventListener('click', submitEdit);
		editCancel.addEventListener('click', cancelEdit);
		editInput.addEventListener('keydown', function (e) {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				submitEdit();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				cancelEdit();
			}
		});
		window.addEventListener('resize', function () {
			if (editBar.classList.contains('visible')) {
				positionEditBar();
			}
		});
	}

	// ── Translate bar ──

	var translateRange = null;

	function positionTranslateBar() {
		if (!translateBar) {
			return;
		}
		var w = translateBar.offsetWidth;
		var h = translateBar.offsetHeight;
		var anchorLeft = lastMouseX;
		var anchorTop = lastMouseY;
		if (mode === 'preview') {
			var sel = window.getSelection();
			if (sel && sel.rangeCount) {
				var rect = sel.getRangeAt(0).getBoundingClientRect();
				if (rect.width || rect.height) {
					anchorLeft = rect.left + rect.width / 2;
					anchorTop = rect.top;
				}
			}
		}
		var left = Math.max(8, Math.min(window.innerWidth - w - 8, anchorLeft - w / 2));
		var top = anchorTop - h - 8;
		if (top < 8) {
			top = anchorTop + 16;
		}
		translateBar.style.left = left + 'px';
		translateBar.style.top = top + 'px';
	}

	function showTranslateBar(range) {
		if (!translateBar || !range) {
			return;
		}
		translateRange = {
			text: range.text,
			startLine: range.startLine,
			endLine: range.endLine,
		};
		bar.style.display = 'none';
		translateBar.classList.remove('done');
		translateBar.classList.remove('error');
		translateBar.classList.add('visible');
		if (translateContent) {
			translateContent.textContent = '';
		}
		if (translateStatusText) {
			translateStatusText.textContent = 'Thinking\u2026';
		}
		if (translateLang) {
			translateLang.textContent = '';
		}
		positionTranslateBar();
		setTimeout(positionTranslateBar, 0);
		vscode.postMessage({
			type: 'translate',
			startLine: translateRange.startLine,
			endLine: translateRange.endLine,
			text: translateRange.text,
		});
	}

	function hideTranslateBar() {
		if (!translateBar) {
			return;
		}
		var wasPending =
			translateBar.classList.contains('visible') &&
			!translateBar.classList.contains('done') &&
			!translateBar.classList.contains('error');
		if (wasPending) {
			vscode.postMessage({ type: 'translateCancel' });
		}
		translateBar.classList.remove('visible');
		translateBar.classList.remove('done');
		translateBar.classList.remove('error');
		if (translateRange) {
			vscode.postMessage({ type: 'previewSelectionCleared' });
		}
		translateRange = null;
	}

	if (translateBar) {
		translateClose.addEventListener('click', hideTranslateBar);
		document.addEventListener('keydown', function (e) {
			if (
				e.key === 'Escape' &&
				translateBar.classList.contains('visible')
			) {
				e.preventDefault();
				hideTranslateBar();
			}
		});
		// Click anywhere outside the translate bar dismisses it.
		document.addEventListener(
			'mousedown',
			function (e) {
				if (!translateBar.classList.contains('visible')) {
					return;
				}
				if (translateBar.contains(e.target)) {
					return;
				}
				hideTranslateBar();
			},
			true,
		);
		window.addEventListener('resize', function () {
			if (translateBar.classList.contains('visible')) {
				positionTranslateBar();
			}
		});
	}

	// ── Selection detection ──

	var selTimer = null;

	document.addEventListener('selectionchange', function () {
		if (mode !== 'preview') {
			return;
		}
		clearTimeout(selTimer);
		selTimer = setTimeout(function () {
			var sel = window.getSelection();
			if (!sel || sel.isCollapsed) {
				hideBar();
			} else {
				showBar();
			}
		}, 200);
	});

	document.addEventListener('mouseup', function (e) {
		if (bar.contains(e.target) || toolbar.contains(e.target)) {
			return;
		}
		if (mode === 'preview') {
			clearTimeout(selTimer);
			setTimeout(showBar, 50);
		}
	});

	sourceTextarea.addEventListener('select', function () {
		clearTimeout(selTimer);
		selTimer = setTimeout(showBar, 200);
	});

	sourceTextarea.addEventListener('mouseup', function () {
		clearTimeout(selTimer);
		setTimeout(showBar, 50);
	});

	sourceTextarea.addEventListener('keyup', function (e) {
		if (e.shiftKey) {
			clearTimeout(selTimer);
			selTimer = setTimeout(showBar, 200);
		} else if (
			sourceTextarea.selectionStart === sourceTextarea.selectionEnd
		) {
			hideBar();
		}
	});

	sourceTextarea.addEventListener('click', function () {
		if (sourceTextarea.selectionStart === sourceTextarea.selectionEnd) {
			hideBar();
		}
	});

	// ── Scroll sync (host → webview) ──

	var scrollingFromHost = false;
	var scrollHostTimer = null;

	window.addEventListener('message', function (e) {
		var msg = e.data;
		if (msg.type === 'scrollTo') {
			scrollingFromHost = true;
			if (scrollHostTimer) {
				clearTimeout(scrollHostTimer);
			}
			scrollHostTimer = setTimeout(function () {
				scrollingFromHost = false;
			}, 300);
			if (mode === 'preview') {
				var all = contentEl.querySelectorAll('[data-source-line]');
				var best = null;
				var bestDist = Infinity;
				for (var i = 0; i < all.length; i++) {
					var l = Number(all[i].dataset.sourceLine);
					var dist = Math.abs(l - msg.line);
					if (dist < bestDist) {
						bestDist = dist;
						best = all[i];
					}
				}
				if (best) {
					var elTop = best.offsetTop - contentScroll.clientHeight / 2;
					contentScroll.scrollTo({ top: Math.max(0, elTop), behavior: 'smooth' });
				}
			} else {
				scrollTextareaToLine(msg.line, true);
			}
		} else if (msg.type === 'updateContent') {
			contentEl.innerHTML = msg.body;
			injectCopyButtons();
		} else if (msg.type === 'updateSource') {
			rawSource = msg.text;
			if (mode === 'source' && !textareaEditing) {
				var start = sourceTextarea.selectionStart;
				var end = sourceTextarea.selectionEnd;
				var scrollPos = sourceTextarea.scrollTop;
				sourceTextarea.value = rawSource;
				sourceTextarea.selectionStart = Math.min(
					start,
					rawSource.length
				);
				sourceTextarea.selectionEnd = Math.min(end, rawSource.length);
				sourceTextarea.scrollTop = scrollPos;
				updateHighlight();
				updateLineNumbers();
				sourceHighlight.scrollTop = scrollPos;
				syncGutterScroll();
			}
		} else if (msg.type === 'updateShowFloatingButton') {
			bar.style.display = 'none';
			bar.dataset.enabled = msg.enabled ? 'true' : 'false';
		} else if (msg.type === 'updateTranslateEnabled') {
			var tBtn = bar.querySelector('[data-action="translate"]');
			if (tBtn) {
				var sep = tBtn.previousElementSibling;
				var on = msg.enabled !== false;
				tBtn.style.display = on ? '' : 'none';
				if (sep && sep.classList.contains('ask-bar-sep')) {
					sep.style.display = on ? '' : 'none';
				}
			}
		} else if (msg.type === 'inlineEditDone') {
			hideEditBar();
		} else if (msg.type === 'inlineEditError') {
			if (!editBar) {
				return;
			}
			editBar.classList.remove('thinking');
			editBar.classList.add('error');
			editInput.disabled = false;
			editSubmit.disabled = false;
			if (editStatusText) {
				editStatusText.textContent =
					typeof msg.error === 'string' ? msg.error : 'Edit failed';
			}
			editInput.focus();
		} else if (msg.type === 'translateResult') {
			if (!translateBar) {
				return;
			}
			var firstChunk = !translateBar.classList.contains('done');
			translateBar.classList.remove('error');
			translateBar.classList.add('done');
			if (translateLang && typeof msg.language === 'string') {
				translateLang.textContent = '(' + msg.language + ')';
			}
			if (translateContent) {
				translateContent.textContent =
					typeof msg.result === 'string' ? msg.result : '';
			}
			if (firstChunk) {
				positionTranslateBar();
			}
		} else if (msg.type === 'translateError') {
			if (!translateBar) {
				return;
			}
			translateBar.classList.remove('done');
			translateBar.classList.add('error');
			if (translateStatusText) {
				translateStatusText.textContent =
					typeof msg.error === 'string' ? msg.error : 'Translate failed';
			}
		}
	});

	// ── Scroll sync (webview → host) ──

	var scrollOutTimer = null;

	function emitScrollLine() {
		if (scrollingFromHost) {
			return;
		}
		if (scrollOutTimer) {
			clearTimeout(scrollOutTimer);
		}
		scrollOutTimer = setTimeout(function () {
			var line;
			if (mode === 'source') {
				var lh =
					parseFloat(getComputedStyle(sourceTextarea).lineHeight) ||
					20;
				line = Math.floor(sourceTextarea.scrollTop / lh) + 1;
			} else {
				var all = contentEl.querySelectorAll('[data-source-line]');
				var best = null;
				for (var i = 0; i < all.length; i++) {
					var rect = all[i].getBoundingClientRect();
					if (rect.top >= 0) {
						best = all[i];
						break;
					}
					best = all[i];
				}
				line = best ? Number(best.dataset.sourceLine) : 1;
			}
			vscode.postMessage({ type: 'scrollFromPreview', line: line });
		}, 50);
	}

	contentScroll.addEventListener('scroll', emitScrollLine);
	sourceTextarea.addEventListener('scroll', emitScrollLine);

	// ── Code block copy buttons ──

	var ICON_COPY = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M3 5V12.73C2.4 12.38 2 11.74 2 11V5C2 2.79 3.79 1 6 1H9C9.74 1 10.38 1.4 10.73 2H6C4.35 2 3 3.35 3 5ZM11 15H6C4.897 15 4 14.103 4 13V5C4 3.897 4.897 3 6 3H11C12.103 3 13 3.897 13 5V13C13 14.103 12.103 15 11 15ZM12 5C12 4.448 11.552 4 11 4H6C5.448 4 5 4.448 5 5V13C5 13.552 5.448 14 6 14H11C11.552 14 12 13.552 12 13V5Z"/></svg>';
	var ICON_CHECK = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M13.6572 3.13573C13.8583 2.9465 14.175 2.95614 14.3643 3.15722C14.5535 3.35831 14.5438 3.675 14.3428 3.86425L5.84277 11.8642C5.64597 12.0494 5.33756 12.0446 5.14648 11.8535L1.64648 8.35351C1.45121 8.15824 1.45121 7.84174 1.64648 7.64647C1.84174 7.45121 2.15825 7.45121 2.35351 7.64647L5.50976 10.8027L13.6572 3.13573Z"/></svg>';

	function injectCopyButtons() {
		var pres = contentEl.querySelectorAll('pre');
		for (var i = 0; i < pres.length; i++) {
			if (pres[i].parentElement && pres[i].parentElement.classList.contains('code-block-wrapper')) {
				continue;
			}
			var wrapper = document.createElement('div');
			wrapper.className = 'code-block-wrapper';
			pres[i].parentNode.insertBefore(wrapper, pres[i]);
			wrapper.appendChild(pres[i]);
			var btn = document.createElement('button');
			btn.className = 'copy-btn';
			btn.innerHTML = ICON_COPY;
			btn.title = 'Copy code';
			wrapper.appendChild(btn);
		}
	}

	contentEl.addEventListener('click', function (e) {
		var btn = e.target.closest('.copy-btn');
		if (!btn) {
			return;
		}
		var wrapper = btn.closest('.code-block-wrapper');
		if (!wrapper) {
			return;
		}
		var pre = wrapper.querySelector('pre');
		var code = pre ? pre.querySelector('code') : null;
		var text = code ? code.textContent : (pre ? pre.textContent : '');
		if (navigator.clipboard && navigator.clipboard.writeText) {
			navigator.clipboard.writeText(text).then(function () {
				btn.innerHTML = ICON_CHECK;
				btn.title = 'Copied';
				setTimeout(function () {
					btn.innerHTML = ICON_COPY;
					btn.title = 'Copy code';
				}, 2000);
			}).catch(function () {
				btn.innerHTML = ICON_COPY;
				btn.classList.add('copy-failed');
				btn.title = 'Copy failed';
				setTimeout(function () {
					btn.classList.remove('copy-failed');
					btn.title = 'Copy code';
				}, 2000);
			});
		}
	});

	injectCopyButtons();
})();
