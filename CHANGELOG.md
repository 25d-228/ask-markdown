# Changelog

## 0.3.16 - 2026-04-17

- Update README to reflect the Add / Inline Edit / Translate toolbar, code-block copy button, and `translateEnabled` setting; drop the stale double-click-to-jump entry

## 0.3.15 - 2026-04-17

- Replace the Claude-backed Translate action with a dictionary lookup (IPA + short definitions) via dictionaryapi.dev
- Replace the `ask-markdown.outputLanguage` setting with `ask-markdown.translateEnabled` to toggle the Translate button
- Live-update the Translate button's visibility when the setting changes

## 0.3.14 - 2026-04-17

- Maintenance release

## 0.3.13 - 2026-04-17

- Dismiss the translate bar on any click outside it
- Disallow all tools in the translate Claude invocation

## 0.3.12 - 2026-04-16

- Pin the inline-edit Claude invocation to the `sonnet` model

## 0.3.11 - 2026-04-16

- Add inline edit bar that rewrites the selected text via Claude
- Add translate bar that renders a translation of the selected text into the configured output language
- Add hover copy button to rendered code blocks
- Rename the preview toolbar "Claude" action to "Add" and add "Inline Edit" and "Translate" actions
