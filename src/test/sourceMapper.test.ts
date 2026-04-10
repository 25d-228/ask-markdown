import * as assert from 'assert';
import * as vscode from 'vscode';
import { toRange } from '../sourceMapper';

suite('sourceMapper — toRange', () => {
	let doc: vscode.TextDocument;

	// 5-line document: lines 0–4
	suiteSetup(async () => {
		doc = await vscode.workspace.openTextDocument({
			content: 'line0\nline1\nline2\nline3\nline4',
			language: 'markdown',
		});
	});

	test('single line', () => {
		const r = toRange(doc, 2, 2);
		assert.strictEqual(r.start.line, 2);
		assert.strictEqual(r.end.line, 2);
		assert.strictEqual(r.start.character, 0);
		assert.strictEqual(r.end.character, 'line2'.length);
	});

	test('multi-line range', () => {
		const r = toRange(doc, 1, 3);
		assert.strictEqual(r.start.line, 1);
		assert.strictEqual(r.end.line, 3);
		assert.strictEqual(r.start.character, 0);
		assert.strictEqual(r.end.character, 'line3'.length);
	});

	test('last line of file', () => {
		const r = toRange(doc, 4, 4);
		assert.strictEqual(r.start.line, 4);
		assert.strictEqual(r.end.line, 4);
		assert.strictEqual(r.end.character, 'line4'.length);
	});

	test('line numbers past EOF are clamped', () => {
		const r = toRange(doc, 10, 20);
		assert.strictEqual(r.start.line, 4);
		assert.strictEqual(r.end.line, 4);
	});

	test('negative line numbers are clamped to 0', () => {
		const r = toRange(doc, -5, -1);
		assert.strictEqual(r.start.line, 0);
		assert.strictEqual(r.end.line, 0);
	});

	test('NaN defaults to 0', () => {
		const r = toRange(doc, NaN, NaN);
		assert.strictEqual(r.start.line, 0);
		assert.strictEqual(r.end.line, 0);
	});

	test('reversed start/end are swapped', () => {
		const r = toRange(doc, 3, 1);
		assert.strictEqual(r.start.line, 1);
		assert.strictEqual(r.end.line, 3);
	});

	test('start past EOF, end in range — clamps start', () => {
		const r = toRange(doc, 100, 2);
		// After clamping: start=4, end=2 → swapped to 2,4
		assert.strictEqual(r.start.line, 2);
		assert.strictEqual(r.end.line, 4);
	});
});
