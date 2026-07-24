import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffRange } from './text-diff.js';

function applyChange(current, { from, to, insert }) {
  return current.slice(0, from) + insert + current.slice(to);
}

test('diffRange finds a single-character edit in the middle of the string', () => {
  const current = 'Person(usder, "User", "A user of the system")';
  const next = 'Person(user, "User", "A user of the system")';
  const range = diffRange(current, next);
  assert.equal(applyChange(current, range), next);
  // Only the touched region should be replaced, not the whole string.
  assert.ok(range.to - range.from < current.length);
});

test('diffRange returns a pure insertion range when text is only appended', () => {
  const current = 'flowchart TD\n  A --> B';
  const next = 'flowchart TD\n  A --> B\n  B --> C';
  const range = diffRange(current, next);
  assert.deepEqual(range, { from: current.length, to: current.length, insert: '\n  B --> C' });
  assert.equal(applyChange(current, range), next);
});

test('diffRange returns a pure deletion range when text is only removed', () => {
  const current = 'flowchart TD\n  A --> B\n  B --> C';
  const next = 'flowchart TD\n  A --> B';
  const range = diffRange(current, next);
  assert.deepEqual(range, { from: next.length, to: current.length, insert: '' });
  assert.equal(applyChange(current, range), next);
});

test('diffRange replaces the whole string when nothing matches at either end', () => {
  const current = 'abc';
  const next = 'xyz';
  const range = diffRange(current, next);
  assert.deepEqual(range, { from: 0, to: 3, insert: 'xyz' });
});

test('diffRange handles a fully-replaced diagram (no shared prefix/suffix with the old one)', () => {
  const current = 'flowchart TD\n  A --> B';
  const next = 'sequenceDiagram\n  Alice->>Bob: Hi';
  const range = diffRange(current, next);
  assert.equal(applyChange(current, range), next);
});
