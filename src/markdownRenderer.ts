import MarkdownIt from 'markdown-it';
const texmath = require('markdown-it-texmath');
const katex = require('katex');
const hljs = require('highlight.js/lib/common');

type Token = Parameters<MarkdownIt['renderer']['render']>[0][number];

/**
 * Build a markdown-it instance whose block-level opening tags carry
 * `data-source-line` / `data-source-line-end` attributes derived from
 * `token.map`. The webview reads these to map a DOM selection back to a
 * source line range.
 *
 * Lives in its own module so that both the preview provider and the
 * rendered-diff webview can share the same markdown-it setup without
 * creating an import cycle (previewProvider ↔ claudeServer ↔
 * renderedDiff) that would break extension activation on load.
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
