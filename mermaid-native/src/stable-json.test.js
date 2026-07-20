import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stableStringify } from './stable-json.js';

test('same data, different key order, produces identical output', () => {
  const a = { diagrams: [{ id: '1', label: 'A', theme: 'default' }] };
  const b = { diagrams: [{ theme: 'default', id: '1', label: 'A' }] };
  assert.equal(stableStringify(a), stableStringify(b));
});

// This is the exact bug this function exists to prevent: the resolver's
// conflict detection compares snapshots with ===, so if key order isn't
// normalized, an ordinary sequential save by the same user could look like
// someone else changed the data first.
test('does not depend on Jira preserving key order round-trip', () => {
  const written = { diagrams: [{ id: '1', label: 'A', source: 'flowchart TD', theme: 'dark' }] };
  const readBack = JSON.parse(JSON.stringify(written));
  // Simulate a hypothetical reordering some storage layer might do.
  const reordered = {
    diagrams: readBack.diagrams.map((d) => ({ theme: d.theme, source: d.source, label: d.label, id: d.id })),
  };
  assert.equal(stableStringify(written), stableStringify(reordered));
});

test('different data produces different output', () => {
  const a = { diagrams: [{ id: '1', label: 'A' }] };
  const b = { diagrams: [{ id: '1', label: 'B' }] };
  assert.notEqual(stableStringify(a), stableStringify(b));
});

test('handles nested arrays and primitives', () => {
  const value = { a: [1, 'two', null, true, { z: 1, a: 2 }], b: undefined };
  assert.doesNotThrow(() => stableStringify(value));
  assert.equal(stableStringify({ b: 1, a: [{ y: 1, x: 2 }] }), stableStringify({ a: [{ x: 2, y: 1 }], b: 1 }));
});
