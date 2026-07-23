import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getNodeIcon, setNodeIcon, QUICK_ICONS, getNodeLabelText, setNodeLabelText } from './node-label.js';

test('getNodeIcon returns empty for a node with no label icon', () => {
  const source = 'flowchart TD\n  A[Start] --> B[End]';
  assert.equal(getNodeIcon(source, 'A'), '');
});

test('setNodeIcon prepends an icon to an existing bracket label', () => {
  const source = 'flowchart TD\n  A[Start] --> B[End]';
  const next = setNodeIcon(source, 'A', '🚀');
  assert.equal(next, 'flowchart TD\n  A[🚀 Start] --> B[End]');
  assert.equal(getNodeIcon(next, 'A'), '🚀');
});

test('setNodeIcon rewrites a label sharing a line with its edge, leaving the rest of the line untouched', () => {
  // This app's own default new-diagram template (App.jsx's newDiagram())
  // puts node+edge+node all on one line — the bug that motivated
  // relaxing findLabelLine to not require the label to span the whole line.
  const source = 'flowchart TD\n  A[Start] --> B[End]';
  const next = setNodeIcon(source, 'A', '🚀');
  assert.equal(next, 'flowchart TD\n  A[🚀 Start] --> B[End]');
});

test('setNodeIcon on the second node on a shared line only touches that node', () => {
  const source = 'flowchart TD\n  A[Start] --> B[End]';
  const next = setNodeIcon(source, 'B', '✅');
  assert.equal(next, 'flowchart TD\n  A[Start] --> B[✅ End]');
});

test('setNodeIcon works on round and diamond shapes too', () => {
  assert.equal(setNodeIcon('flowchart TD\n  A(Round)', 'A', '⚙️'), 'flowchart TD\n  A(⚙️ Round)');
  assert.equal(setNodeIcon('flowchart TD\n  A{Diamond}', 'A', '✅'), 'flowchart TD\n  A{✅ Diamond}');
});

test('setNodeIcon swaps a previously-set icon rather than stacking it', () => {
  const source = 'flowchart TD\n  A[🚀 Start]';
  const next = setNodeIcon(source, 'A', '✅');
  assert.equal(next, 'flowchart TD\n  A[✅ Start]');
});

test('setNodeIcon clears the icon when passed a falsy value, restoring the plain text', () => {
  const source = 'flowchart TD\n  A[🚀 Start]';
  const next = setNodeIcon(source, 'A', '');
  assert.equal(next, 'flowchart TD\n  A[Start]');
});

test('setNodeIcon on an icon-only label (no other text) clears back to empty brackets', () => {
  const source = 'flowchart TD\n  A[🚀]';
  const next = setNodeIcon(source, 'A', '');
  assert.equal(next, 'flowchart TD\n  A[]');
});

test('setNodeIcon synthesizes a new label for an edge-only node with no shape at all', () => {
  const source = 'flowchart TD\n  A --> B';
  const next = setNodeIcon(source, 'A', '🚀');
  assert.equal(next, 'flowchart TD\n  A --> B\nA[🚀]');
});

test('setNodeIcon is a no-op for an unrecognized doubled-bracket shape', () => {
  const source = 'flowchart TD\n  A((Circle))';
  const next = setNodeIcon(source, 'A', '🚀');
  assert.equal(next, source);
});

test('getNodeIcon does not recognize a hand-typed emoji outside the curated set', () => {
  const source = 'flowchart TD\n  A[🎉 Start]';
  assert.equal(getNodeIcon(source, 'A'), '');
});

test('setNodeIcon prepending in front of a hand-typed emoji does not strip it (best-effort, not perfect)', () => {
  const source = 'flowchart TD\n  A[🎉 Start]';
  const next = setNodeIcon(source, 'A', '🚀');
  assert.equal(next, 'flowchart TD\n  A[🚀 🎉 Start]');
});

test('QUICK_ICONS is a small curated, non-empty set', () => {
  assert.ok(QUICK_ICONS.length > 0);
  assert.ok(QUICK_ICONS.length < 20);
});

// Regression tests: a node declared via Mermaid v11's unified
// `@{ shape: ..., label: "..." }` syntax (diagram-palette.js) used to be
// invisible to findLabelLine (which only recognizes bracket pairs), so
// setNodeIcon fell through to its "synthesize a new NodeId[icon] line"
// fallback — adding a *second*, conflicting declaration for the same id
// that silently won and discarded the original shape and label entirely.
test('getNodeIcon reads the label out of an @{shape:...} declaration', () => {
  const source = 'flowchart TD\n  A@{ shape: rect, label: "🚀 Deploy" }';
  assert.equal(getNodeIcon(source, 'A'), '🚀');
});

test('setNodeIcon rewrites the label inside @{shape:...} in place, preserving the shape', () => {
  const source = 'flowchart TD\n  A[Start] --> B{Decision}\n  E@{ shape: rect, label: "Process" }';
  const next = setNodeIcon(source, 'E', '🚀');
  assert.equal(next, 'flowchart TD\n  A[Start] --> B{Decision}\n  E@{ shape: rect, label: "🚀 Process" }');
});

test('setNodeIcon clears an icon from an @{shape:...} label without disturbing the shape', () => {
  const source = 'flowchart TD\n  E@{ shape: rect, label: "🚀 Process" }';
  const next = setNodeIcon(source, 'E', '');
  assert.equal(next, 'flowchart TD\n  E@{ shape: rect, label: "Process" }');
});

// getNodeLabelText / setNodeLabelText: the double-click-to-edit-text
// gesture's flowchart backend. Same three-tier dispatch as setNodeIcon
// (bracket shape, @{...} shape, synthesize-or-no-op), but a full replace
// rather than a prefix merge.
test('getNodeLabelText reads a bracket label, empty string for no shape/label at all', () => {
  assert.equal(getNodeLabelText('flowchart TD\n  A[Start] --> B[End]', 'A'), 'Start');
  assert.equal(getNodeLabelText('flowchart TD\n  A --> B', 'A'), '');
});

test('setNodeLabelText fully replaces a bracket label, including a previously-set icon', () => {
  const source = 'flowchart TD\n  A[🚀 Start] --> B[End]';
  assert.equal(setNodeLabelText(source, 'A', 'Kickoff'), 'flowchart TD\n  A[Kickoff] --> B[End]');
});

test('setNodeLabelText synthesizes a new label for an edge-only node with no shape at all', () => {
  assert.equal(setNodeLabelText('flowchart TD\n  A --> B', 'A', 'Begin'), 'flowchart TD\n  A --> B\nA[Begin]');
});

test('setNodeLabelText is a no-op for an unrecognized doubled-bracket shape, and for an empty text with no shape to synthesize onto', () => {
  assert.equal(setNodeLabelText('flowchart TD\n  A((Circle))', 'A', 'x'), 'flowchart TD\n  A((Circle))');
  assert.equal(setNodeLabelText('flowchart TD\n  A --> B', 'A', ''), 'flowchart TD\n  A --> B');
});

test('getNodeLabelText / setNodeLabelText round-trip an @{shape:...} declaration, preserving the shape property', () => {
  const source = 'flowchart TD\n  E@{ shape: rect, label: "Process" }';
  assert.equal(getNodeLabelText(source, 'E'), 'Process');
  assert.equal(
    setNodeLabelText(source, 'E', 'Handle request'),
    'flowchart TD\n  E@{ shape: rect, label: "Handle request" }'
  );
});
