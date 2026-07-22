import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveNodeStyleKind } from './node-style-kind.js';

test('resolves flowchart source to the flowchart style module', () => {
  const kind = resolveNodeStyleKind('flowchart TD\n  A --> B');
  assert.equal(kind.kind, 'flowchart');
  assert.deepEqual(kind.parseIds('flowchart TD\n  A --> B'), ['A', 'B']);
});

test('resolves stateDiagram-v2 source to the state style module', () => {
  const kind = resolveNodeStyleKind('stateDiagram-v2\n  [*] --> A');
  assert.equal(kind.kind, 'state');
  assert.deepEqual(kind.parseIds('stateDiagram-v2\n  [*] --> A'), ['A']);
});

test('resolves erDiagram source to the ER style module', () => {
  const kind = resolveNodeStyleKind('erDiagram\nA ||--o{ B : has');
  assert.equal(kind.kind, 'er');
  assert.deepEqual(kind.parseIds('erDiagram\nA ||--o{ B : has'), ['A', 'B']);
});

test('returns null for a diagram type with no per-element style mechanism', () => {
  assert.equal(resolveNodeStyleKind('pie title Pets\n  "Dogs" : 40\n  "Cats" : 60'), null);
  assert.equal(resolveNodeStyleKind('sequenceDiagram\n  Alice->>Bob: Hi'), null);
});
