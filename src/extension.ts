import * as vscode from 'vscode';
import { AskMarkdownEditorProvider } from './previewProvider';
import { startServer, stopServer } from './claudeServer';

export function activate(context: vscode.ExtensionContext) {
	console.log('[ask-markdown] activated');

	const diag = vscode.window.createOutputChannel('Ask Markdown');
	context.subscriptions.push(diag);

	startServer().then((port) => {
		console.log(`[ask-markdown] Claude server ready on port ${port}`);
	}).catch((err) => {
		console.error('[ask-markdown] Failed to start Claude server:', err);
	});

	// A tab ref stores the *criteria* for identifying a tab, not the Tab
	// reference itself. VS Code's `tabGroups.all` can construct fresh Tab
	// objects on each access, so identity comparison (`Set.has(tab)`) after a
	// round trip like `vscode.openWith` is unreliable. Re-matching against
	// live tabs at close time is the robust approach.
	type MarkdownTabRef =
		| { kind: 'text'; uriKey: string }
		| { kind: 'custom'; uriKey: string; viewType: string }
		| { kind: 'webview'; viewType: string; label: string }
		// Fallback for tabs whose input doesn't expose a `.uri` and isn't a
		// known TabInput class (e.g. Cursor's preview-mode `workbench.
		// editor.markdown`). We resolve the URI from the label at collect
		// time and identify the tab by its stable label + group index.
		| { kind: 'label'; label: string };

	interface MarkdownTarget {
		uri: vscode.Uri;
		tabRefs: MarkdownTabRef[];
		sources: Array<'source' | 'preview'>;
	}

	// Pull a URI off a tab input via duck-typing. `instanceof` checks on
	// `vscode.TabInputCustom` can fail for editors whose class isn't a
	// public API entry (e.g. Cursor's builtin `workbench.editor.markdown`
	// in Preview mode), so we sniff `.uri` / `.viewType` directly.
	const readUriFromInput = (
		input: unknown,
	): { uri: vscode.Uri; viewType?: string } | undefined => {
		if (!input || typeof input !== 'object') {
			return undefined;
		}
		const record = input as { uri?: unknown; viewType?: unknown };
		if (!(record.uri instanceof vscode.Uri)) {
			return undefined;
		}
		return {
			uri: record.uri,
			viewType:
				typeof record.viewType === 'string'
					? record.viewType
					: undefined,
		};
	};

	const tabRefMatches = (
		tab: vscode.Tab,
		ref: MarkdownTabRef,
	): boolean => {
		if (ref.kind === 'text') {
			return (
				tab.input instanceof vscode.TabInputText &&
				tab.input.uri.toString() === ref.uriKey
			);
		}
		if (ref.kind === 'custom') {
			const info = readUriFromInput(tab.input);
			if (!info) {
				return false;
			}
			if (info.viewType === AskMarkdownEditorProvider.viewType) {
				return false;
			}
			if (info.uri.toString() !== ref.uriKey) {
				return false;
			}
			// ref.viewType is only a hint when the input exposes one.
			if (ref.viewType && info.viewType && info.viewType !== ref.viewType) {
				return false;
			}
			return true;
		}
		if (ref.kind === 'webview') {
			return (
				tab.input instanceof vscode.TabInputWebview &&
				tab.input.viewType === ref.viewType &&
				tab.label === ref.label
			);
		}
		// kind === 'label' — fallback for unknown input classes.
		if (tab.label !== ref.label) {
			return false;
		}
		// Defensively exclude any tab that's now our own preview.
		const info = readUriFromInput(tab.input);
		if (info?.viewType === AskMarkdownEditorProvider.viewType) {
			return false;
		}
		if (tab.input instanceof vscode.TabInputText) {
			return false;
		}
		return true;
	};

	const escapeGlob = (s: string): string =>
		s.replace(/[\\[\]{}*?()]/g, (ch) => '\\' + ch);

	// Best-effort URI resolution from a webview tab's label. Built-in
	// Markdown previews tuck the filename into the label ("Preview foo.md",
	// "[Preview] foo", etc.). Extract a `.md` filename or bare stem, then
	// try in-memory text docs before falling back to a workspace file
	// search.
	const resolveUriFromLabel = async (
		label: string,
	): Promise<vscode.Uri | undefined> => {
		const labelLower = label.toLowerCase();

		for (const doc of vscode.workspace.textDocuments) {
			if (doc.languageId !== 'markdown') {
				continue;
			}
			const filename = (
				doc.uri.path.split('/').pop() ?? ''
			).toLowerCase();
			if (!filename) {
				continue;
			}
			const stem = filename.replace(/\.md$/, '');
			if (
				labelLower.includes(filename) ||
				(stem.length > 0 && labelLower.includes(stem))
			) {
				return doc.uri;
			}
		}

		const explicit = labelLower.match(/([a-z0-9._+-]+\.md)/);
		if (explicit) {
			const hits = await vscode.workspace.findFiles(
				`**/${escapeGlob(explicit[1])}`,
				'**/node_modules/**',
				5,
			);
			if (hits.length > 0) {
				return hits[0];
			}
		}

		return undefined;
	};

	// Walk every tab in every tab group and build a URI → MarkdownTarget map.
	// A markdown file can surface as a source text tab, a built-in markdown
	// preview webview tab, or both; we group both under the same URI so the
	// picker shows one entry per file and `close` can dismiss everything.
	const collectMarkdownTargets = async (): Promise<MarkdownTarget[]> => {
		const byUri = new Map<string, MarkdownTarget>();

		const add = (
			uri: vscode.Uri,
			ref: MarkdownTabRef,
			source: 'source' | 'preview',
		): void => {
			const key = uri.toString();
			let entry = byUri.get(key);
			if (!entry) {
				entry = { uri, tabRefs: [], sources: [] };
				byUri.set(key, entry);
			}
			entry.tabRefs.push(ref);
			if (!entry.sources.includes(source)) {
				entry.sources.push(source);
			}
		};

		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if (tab.input instanceof vscode.TabInputText) {
					if (tab.input.uri.path.toLowerCase().endsWith('.md')) {
						add(
							tab.input.uri,
							{ kind: 'text', uriKey: tab.input.uri.toString() },
							'source',
						);
					}
					continue;
				}

				// Duck-typed catch-all for custom editors: any tab whose
				// input exposes a `.uri` pointing at an `.md` file. This
				// covers `TabInputCustom`, and any input class that follows
				// the same shape.
				const info = readUriFromInput(tab.input);
				if (info) {
					if (info.viewType === AskMarkdownEditorProvider.viewType) {
						continue;
					}
					if (info.uri.path.toLowerCase().endsWith('.md')) {
						add(
							info.uri,
							{
								kind: 'custom',
								uriKey: info.uri.toString(),
								viewType: info.viewType ?? '',
							},
							'source',
						);
						continue;
					}
				}

				if (tab.input instanceof vscode.TabInputWebview) {
					const uri = await resolveUriFromLabel(tab.label);
					if (uri) {
						add(
							uri,
							{
								kind: 'webview',
								viewType: tab.input.viewType,
								label: tab.label,
							},
							'preview',
						);
					}
					continue;
				}

				// Universal label-based fallback for exotic tab classes
				// (e.g. Cursor's Preview-mode `workbench.editor.markdown`,
				// which is neither a TabInputText, TabInputCustom, nor
				// TabInputWebview in some builds). If the label looks like
				// a markdown filename, resolve it via the workspace.
				if (tab.label.toLowerCase().includes('.md')) {
					const uri = await resolveUriFromLabel(tab.label);
					if (uri) {
						add(
							uri,
							{ kind: 'label', label: tab.label },
							'source',
						);
						continue;
					}
				}

				// Log unmatched tabs to an output channel so we can
				// diagnose detection gaps without shipping another build.
				try {
					const shape = {
						label: tab.label,
						inputCtor: tab.input?.constructor?.name,
						inputKeys:
							tab.input && typeof tab.input === 'object'
								? Object.keys(
										tab.input as Record<string, unknown>,
									)
								: [],
					};
					diag.appendLine(
						`[unmatched tab] ${JSON.stringify(shape)}`,
					);
				} catch {
					// ignore
				}
			}
		}

		return Array.from(byUri.values());
	};

	const pickMarkdownTarget = async (
		targets: MarkdownTarget[],
	): Promise<MarkdownTarget | undefined> => {
		const items = targets.map((t) => ({
			label: t.uri.path.split('/').pop() ?? t.uri.path,
			description: t.sources.join(' + '),
			detail: t.uri.fsPath,
			target: t,
		}));
		const picked = await vscode.window.showQuickPick(items, {
			placeHolder: 'Select a markdown file to open in Ask Markdown preview',
			matchOnDescription: true,
			matchOnDetail: true,
		});
		return picked?.target;
	};

	// Parse each workspace folder's .gitignore and return the set of bare
	// directory names it ignores (e.g. "dist", "out", ".next"). We only
	// handle simple folder entries: no globs, no negations, no nested
	// paths. That covers the common build/cache dirs users want skipped in
	// the "pick any .md in the workspace" fallback without committing to a
	// full gitignore parser.
	const readGitignoreFolders = async (): Promise<string[]> => {
		const folders = new Set<string>();
		for (const ws of vscode.workspace.workspaceFolders ?? []) {
			let content: string;
			try {
				const bytes = await vscode.workspace.fs.readFile(
					vscode.Uri.joinPath(ws.uri, '.gitignore'),
				);
				content = new TextDecoder().decode(bytes);
			} catch {
				continue;
			}
			for (const rawLine of content.split(/\r?\n/)) {
				const line = rawLine.trim();
				if (!line || line.startsWith('#') || line.startsWith('!')) {
					continue;
				}
				const stripped = line
					.replace(/^\/+/, '')
					.replace(/\/+$/, '');
				if (!stripped || !/^[a-zA-Z0-9._+-]+$/.test(stripped)) {
					continue;
				}
				folders.add(stripped);
			}
		}
		return Array.from(folders);
	};

	// Search the entire workspace for .md files and let the user pick one.
	// Used as a fallback when no markdown tab is open and no markdown editor
	// is active — so running the command from a scratch workspace still has
	// a way to reach a file.
	const pickMarkdownFromWorkspace = async (): Promise<
		MarkdownTarget | undefined
	> => {
		const excludeNames = new Set<string>([
			'node_modules',
			...(await readGitignoreFolders()),
		]);
		const excludePattern =
			excludeNames.size === 1
				? `**/${[...excludeNames][0]}/**`
				: `**/{${[...excludeNames].join(',')}}/**`;
		const files = await vscode.workspace.findFiles(
			'**/*.md',
			excludePattern,
		);
		if (files.length === 0) {
			return undefined;
		}
		const items = files
			.map((uri) => ({
				label: uri.path.split('/').pop() ?? uri.path,
				description: vscode.workspace.asRelativePath(uri, false),
				uri,
			}))
			.sort((a, b) => a.description.localeCompare(b.description));
		const picked = await vscode.window.showQuickPick(items, {
			placeHolder: 'Select a markdown file from the workspace',
			matchOnDescription: true,
		});
		if (!picked) {
			return undefined;
		}
		return {
			uri: picked.uri,
			tabRefs: [],
			sources: ['source'],
		};
	};

	const resolveTargetMarkdown = async (): Promise<
		MarkdownTarget | undefined
	> => {
		const targets = await collectMarkdownTargets();
		const active = vscode.window.activeTextEditor;

		// No visible markdown tabs at all — fall back to the active text
		// editor only if it's markdown. No stale "last opened" memory:
		// closing a tab should forget it. If nothing in the editor either,
		// offer every .md in the workspace.
		if (targets.length === 0) {
			if (active?.document.languageId === 'markdown') {
				return {
					uri: active.document.uri,
					tabRefs: [],
					sources: ['source'],
				};
			}
			return pickMarkdownFromWorkspace();
		}

		if (targets.length === 1) {
			return targets[0];
		}

		// Multiple markdown tabs are open — always prompt, even when one is
		// the currently-focused editor. The user may want any of them.
		return pickMarkdownTarget(targets);
	};

	context.subscriptions.push(
		AskMarkdownEditorProvider.register(context),

		vscode.commands.registerCommand('ask-markdown.showPreview', async () => {
			const target = await resolveTargetMarkdown();
			if (!target) {
				vscode.window.showInformationMessage(
					'Ask Markdown: open a markdown file first.',
				);
				return;
			}
			await vscode.commands.executeCommand(
				'vscode.openWith',
				target.uri,
				AskMarkdownEditorProvider.viewType,
			);
			// Re-resolve each captured ref against the live tab state.
			// `openWith` may have replaced a same-URI custom/text tab in
			// place, in which case no live tab matches the ref and we skip
			// it. Also defensively skip any live tab that now points at our
			// own viewType.
			if (target.tabRefs.length > 0) {
				const closable: vscode.Tab[] = [];
				for (const group of vscode.window.tabGroups.all) {
					for (const tab of group.tabs) {
						if (
							tab.input instanceof vscode.TabInputCustom &&
							tab.input.viewType ===
								AskMarkdownEditorProvider.viewType
						) {
							continue;
						}
						if (
							target.tabRefs.some((ref) =>
								tabRefMatches(tab, ref),
							)
						) {
							closable.push(tab);
						}
					}
				}
				if (closable.length > 0) {
					try {
						await vscode.window.tabGroups.close(closable);
					} catch (err) {
						console.warn(
							'[ask-markdown] Failed to close original tabs:',
							err,
						);
					}
				}
			}
		}),

		// Flip a text editor back to the Ask Markdown preview in-place.
		// Shown as "</>" in the editor title bar so the user can flip
		// back and forth between rendered preview and source.
		vscode.commands.registerCommand('ask-markdown.flipToPreview', async () => {
			let uri: vscode.Uri | undefined;
			let viewColumn = vscode.ViewColumn.Active;

			// Try the active text editor first (plain source editing).
			const editor = vscode.window.activeTextEditor;
			if (editor?.document.languageId === 'markdown') {
				uri = editor.document.uri;
				viewColumn = editor.viewColumn ?? vscode.ViewColumn.Active;
			} else {
				// Fallback: read the URI from the active tab's input.
				// Covers Cursor's built-in markdown editor which may
				// not expose an activeTextEditor.
				const activeTab =
					vscode.window.tabGroups.activeTabGroup.activeTab;
				if (activeTab) {
					const info = readUriFromInput(activeTab.input);
					if (info?.uri.path.toLowerCase().endsWith('.md')) {
						// Don't flip if we're already in our own preview.
						if (
							info.viewType ===
							AskMarkdownEditorProvider.viewType
						) {
							return;
						}
						uri = info.uri;
					}
				}
			}

			if (!uri) {
				return;
			}

			// Locate the current tab before opening the preview — the
			// tab list may change once the custom editor activates.
			const currentTab = vscode.window.tabGroups.all
				.flatMap((g) => g.tabs)
				.find((t) => {
					if (t.input instanceof vscode.TabInputText) {
						return (
							t.input.uri.toString() === uri!.toString()
						);
					}
					const info = readUriFromInput(t.input);
					if (!info) {
						return false;
					}
					if (
						info.viewType ===
						AskMarkdownEditorProvider.viewType
					) {
						return false;
					}
					return info.uri.toString() === uri!.toString();
				});

			await vscode.commands.executeCommand(
				'vscode.openWith',
				uri,
				AskMarkdownEditorProvider.viewType,
				viewColumn,
			);

			if (currentTab) {
				try {
					await vscode.window.tabGroups.close(currentTab);
				} catch {
					// Tab may already have been replaced
				}
			}
		}),
	);

	// When defaultEditor is enabled, auto-open .md files in our preview.
	const openIfDefault = (editor: vscode.TextEditor | undefined): void => {
		if (!editor) {
			return;
		}
		const config = vscode.workspace.getConfiguration('ask-markdown');
		if (!config.get<boolean>('defaultEditor', false)) {
			return;
		}
		if (editor.document.languageId !== 'markdown') {
			return;
		}
		// Only redirect if it's a regular text editor (not already our custom editor).
		const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
		if (tab?.input instanceof vscode.TabInputText) {
			vscode.commands.executeCommand(
				'vscode.openWith',
				editor.document.uri,
				AskMarkdownEditorProvider.viewType,
			);
		}
	};

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor((editor) => {
			openIfDefault(editor);
		}),
	);

	// Also check the current editor on activation.
	openIfDefault(vscode.window.activeTextEditor);
}

export function deactivate() {
	stopServer();
}
