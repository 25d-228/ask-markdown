import * as https from 'https';

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

interface DictionaryRow {
	pos: string;
	definition: string;
}

interface FormattedDictionaryEntry {
	ipa: string;
	rows: DictionaryRow[];
	fallback?: string;
}

function formatDictionaryEntry(
	data: unknown,
	word: string,
): FormattedDictionaryEntry {
	const entries = Array.isArray(data) ? (data as DictionaryEntry[]) : [];
	if (entries.length === 0) {
		return { ipa: '', rows: [], fallback: `No entry found for "${word}".` };
	}

	let ipa = '';
	for (const entry of entries) {
		ipa = pickIPA(entry);
		if (ipa) {
			break;
		}
	}

	const rows: DictionaryRow[] = [];
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
					rows.push({ pos, definition: def.definition });
					count++;
				}
			}
		}
	}

	if (rows.length === 0) {
		return {
			ipa,
			rows: [],
			fallback: `No definitions available for "${word}".`,
		};
	}

	return { ipa, rows };
}

export type TranslatePost = (msg: { type: string; [key: string]: unknown }) => void;

export class TranslateRunner {
	private controller: AbortController | null = null;

	start(text: string, post: TranslatePost): void {
		if (this.controller) {
			this.controller.abort();
			this.controller = null;
		}

		const wordMatch = text.match(/[a-zA-Z][a-zA-Z'-]*/);
		const word = wordMatch ? wordMatch[0].toLowerCase() : '';

		if (!word) {
			post({
				type: 'translateError',
				error: 'Select an English word to look up.',
			});
			return;
		}

		const url =
			'https://api.dictionaryapi.dev/api/v2/entries/en/' +
			encodeURIComponent(word);
		const controller = new AbortController();
		this.controller = controller;

		const req = https.get(
			url,
			{ signal: controller.signal },
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('end', () => {
					if (this.controller !== controller) {
						return;
					}
					this.controller = null;

					if (res.statusCode === 404) {
						post({
							type: 'translateError',
							error: `"${word}" not found in dictionary.`,
						});
						return;
					}
					if (res.statusCode !== 200) {
						post({
							type: 'translateError',
							error: `Lookup failed (HTTP ${res.statusCode ?? '?'}).`,
						});
						return;
					}

					try {
						const data = JSON.parse(
							Buffer.concat(chunks).toString(),
						);
						const formatted = formatDictionaryEntry(data, word);
						post({
							type: 'translateResult',
							ipa: formatted.ipa,
							rows: formatted.rows,
							fallback: formatted.fallback,
							language: 'en',
							streaming: false,
						});
					} catch (err) {
						post({
							type: 'translateError',
							error: `Failed to parse response: ${(err as Error).message}`,
						});
					}
				});
			},
		);
		req.on('error', (err) => {
			if (this.controller !== controller) {
				return;
			}
			this.controller = null;
			if ((err as NodeJS.ErrnoException).code === 'ABORT_ERR') {
				return;
			}
			post({
				type: 'translateError',
				error: `Network error: ${err.message}`,
			});
		});
	}

	cancel(): void {
		if (this.controller) {
			this.controller.abort();
			this.controller = null;
		}
	}

	dispose(): void {
		this.cancel();
	}
}
