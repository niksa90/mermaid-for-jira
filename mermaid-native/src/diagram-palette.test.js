import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePaletteKind, nextAvailableId } from './diagram-palette.js';

test('nextAvailableId picks A when nothing is used, then walks the alphabet', () => {
  assert.equal(nextAvailableId([]), 'A');
  assert.equal(nextAvailableId(['A']), 'B');
  assert.equal(nextAvailableId(['A', 'B', 'C']), 'D');
});

test('nextAvailableId skips gaps and wraps to a numbered suffix once A-Z is exhausted', () => {
  assert.equal(nextAvailableId(['A', 'C']), 'B');
  const allLetters = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
  assert.equal(nextAvailableId(allLetters), 'A2');
});

test('resolvePaletteKind returns null for diagram types with no palette yet', () => {
  assert.equal(resolvePaletteKind('pie title x\n  "A" : 1'), null);
  assert.equal(resolvePaletteKind('gantt\n  title x'), null);
  assert.equal(resolvePaletteKind('classDiagram\n  class Animal'), null);
  assert.equal(resolvePaletteKind(''), null);
});

test('resolvePaletteKind recognizes flowchart and offers a Lane entry alongside node shapes', () => {
  const palette = resolvePaletteKind('flowchart TD\n  A --> B');
  assert.equal(palette.kind, 'flowchart');
  assert.ok(palette.entries.length > 5);
  assert.ok(palette.entries.some((e) => e.id === 'process'));
  assert.ok(palette.entries.some((e) => e.id === 'lane'));
});

test('flowchart shape entries append a v11 unified-shape node with a fresh id', () => {
  const palette = resolvePaletteKind('flowchart TD\n  A --> B');
  const process = palette.entries.find((e) => e.id === 'process');
  const next = process.insert('flowchart TD\n  A --> B');
  assert.equal(next, 'flowchart TD\n  A --> B\nC@{ shape: rect, label: "Process" }');
});

test('flowchart shape entries pick an id that does not collide with existing nodes', () => {
  const palette = resolvePaletteKind('flowchart TD\n  A --> B\n  B --> C');
  const decision = palette.entries.find((e) => e.id === 'decision');
  const next = decision.insert('flowchart TD\n  A --> B\n  B --> C');
  assert.equal(next, 'flowchart TD\n  A --> B\n  B --> C\nD@{ shape: diamond, label: "Decision" }');
});

test('the Lane entry inserts a subgraph block, not a node shape', () => {
  const palette = resolvePaletteKind('flowchart TD\n  A --> B');
  const lane = palette.entries.find((e) => e.id === 'lane');
  const next = lane.insert('flowchart TD\n  A --> B');
  assert.equal(next, 'flowchart TD\n  A --> B\nsubgraph C[Lane]\nend');
});

test('resolvePaletteKind recognizes sequence diagrams', () => {
  const palette = resolvePaletteKind('sequenceDiagram\n  participant A\n  A->>A: noop');
  assert.equal(palette.kind, 'sequence');
  assert.ok(palette.entries.some((e) => e.id === 'participant'));
  assert.ok(palette.entries.some((e) => e.id === 'actor'));
  assert.ok(palette.entries.some((e) => e.id === 'loop'));
});

test('sequence Participant/Actor entries append a fresh id, not colliding with existing ones', () => {
  const source = 'sequenceDiagram\n  participant A\n  actor B\n  A->>B: hi';
  const palette = resolvePaletteKind(source);
  const participant = palette.entries.find((e) => e.id === 'participant');
  const actor = palette.entries.find((e) => e.id === 'actor');
  assert.equal(participant.insert(source), `${source}\nparticipant C`);
  assert.equal(actor.insert(source), `${source}\nactor C`);
});

test('sequence block entries (loop/alt/opt/par/note) reference the diagram\'s own existing participants', () => {
  const source = 'sequenceDiagram\n  participant Alice\n  participant Bob\n  Alice->>Bob: hi';
  const palette = resolvePaletteKind(source);
  const loop = palette.entries.find((e) => e.id === 'loop');
  const next = loop.insert(source);
  assert.match(next, /loop Every message\n {4}Alice->>Bob: message\nend$/);
});

test('sequence block entries fall back to fresh ids when there are no existing participants', () => {
  const source = 'sequenceDiagram\n  Note over A: placeholder';
  const palette = resolvePaletteKind(source);
  const opt = palette.entries.find((e) => e.id === 'opt');
  const next = opt.insert(source);
  assert.match(next, /opt condition\n {4}A->>B: message\nend$/);
});
