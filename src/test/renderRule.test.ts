import * as assert from 'assert';
import { createMarkdownIt } from '../previewProvider';

suite('Render rules — data-source-line injection', () => {
	const md = createMarkdownIt();

	function hasSourceLine(html: string, tag: string): boolean {
		// Match an opening tag that carries data-source-line
		const pattern = new RegExp(`<${tag}[^>]+data-source-line="\\d+"`);
		return pattern.test(html);
	}

	test('paragraph', () => {
		const html = md.render('Hello world\n');
		assert.ok(
			hasSourceLine(html, 'p'),
			`Expected <p> with data-source-line, got:\n${html}`,
		);
	});

	test('heading', () => {
		const html = md.render('# Title\n');
		assert.ok(
			hasSourceLine(html, 'h1'),
			`Expected <h1> with data-source-line, got:\n${html}`,
		);
	});

	test('bullet list', () => {
		const html = md.render('- one\n- two\n');
		assert.ok(
			hasSourceLine(html, 'ul'),
			`Expected <ul> with data-source-line, got:\n${html}`,
		);
		assert.ok(
			hasSourceLine(html, 'li'),
			`Expected <li> with data-source-line, got:\n${html}`,
		);
	});

	test('ordered list', () => {
		const html = md.render('1. first\n2. second\n');
		assert.ok(
			hasSourceLine(html, 'ol'),
			`Expected <ol> with data-source-line, got:\n${html}`,
		);
	});

	test('fenced code block', () => {
		const html = md.render('```\ncode\n```\n');
		assert.ok(
			hasSourceLine(html, 'code'),
			`Expected <code> with data-source-line, got:\n${html}`,
		);
	});

	test('blockquote', () => {
		const html = md.render('> quoted text\n');
		assert.ok(
			hasSourceLine(html, 'blockquote'),
			`Expected <blockquote> with data-source-line, got:\n${html}`,
		);
	});

	test('table', () => {
		const html = md.render('| a | b |\n|---|---|\n| 1 | 2 |\n');
		assert.ok(
			hasSourceLine(html, 'table'),
			`Expected <table> with data-source-line, got:\n${html}`,
		);
	});

	test('math block ($$)', () => {
		const html = md.render('$$\nx^2\n$$\n');
		// texmath's math_block is wrapped in a <div> with data-source-line
		assert.ok(
			hasSourceLine(html, 'div'),
			`Expected <div> wrapper with data-source-line for math_block, got:\n${html}`,
		);
	});

	test('correct line numbers for second block', () => {
		const html = md.render('first paragraph\n\nsecond paragraph\n');
		// Second paragraph starts at source line 3 (1-based)
		assert.ok(
			html.includes('data-source-line="3"'),
			`Expected data-source-line="3" for second paragraph, got:\n${html}`,
		);
	});

	test('data-source-line-end is present', () => {
		const html = md.render('# Title\n\nA paragraph\nwith two lines.\n');
		// The paragraph spans lines 3–4 → data-source-line-end="4"
		assert.ok(
			html.includes('data-source-line-end="4"'),
			`Expected data-source-line-end="4", got:\n${html}`,
		);
	});
});
