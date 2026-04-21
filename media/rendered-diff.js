(function () {
	'use strict';

	var data = window.__diffData__ || { removedLines: [], addedLines: [] };
	var removed = new Set(data.removedLines || []);
	var added = new Set(data.addedLines || []);

	function markPane(paneId, changedLines, cssClass) {
		var pane = document.getElementById(paneId);
		if (!pane) {
			return;
		}
		var blocks = pane.querySelectorAll('[data-source-line]');
		for (var b = 0; b < blocks.length; b++) {
			var block = blocks[b];
			var start = parseInt(block.getAttribute('data-source-line'), 10);
			var endAttr = block.getAttribute('data-source-line-end');
			var end = endAttr ? parseInt(endAttr, 10) : start;
			if (isNaN(start)) {
				continue;
			}
			for (var line = start; line <= end; line++) {
				if (changedLines.has(line)) {
					block.classList.add(cssClass);
					break;
				}
			}
		}
	}

	function scrollToFirstChange() {
		var first = document.querySelector('#new-pane .diff-added');
		if (!first) {
			first = document.querySelector('#old-pane .diff-removed');
		}
		if (first && first.scrollIntoView) {
			first.scrollIntoView({ block: 'center' });
		}
	}

	function init() {
		markPane('old-pane', removed, 'diff-removed');
		markPane('new-pane', added, 'diff-added');
		scrollToFirstChange();
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
