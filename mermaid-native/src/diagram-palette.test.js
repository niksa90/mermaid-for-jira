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
});

// A blank source has no diagram-type keyword for detectDiagramKind to find
// at all — defaulting to 'flowchart' here (rather than null) is deliberate:
// the palette used to just disappear the moment a diagram was emptied out,
// which is exactly when it would have been most useful. Each entry's
// insert() supplies the missing `flowchart TD` header itself (see
// ensureHeader), so this doubles as a way to start a diagram from nothing.
test('resolvePaletteKind defaults to flowchart for a blank/whitespace-only source', () => {
  assert.equal(resolvePaletteKind('').kind, 'flowchart');
  assert.equal(resolvePaletteKind('   \n  ').kind, 'flowchart');
});

test('resolvePaletteKind recognizes flowchart and offers a Lane entry alongside node shapes', () => {
  const palette = resolvePaletteKind('flowchart TD\n  A --> B');
  assert.equal(palette.kind, 'flowchart');
  assert.ok(palette.entries.length > 5);
  assert.ok(palette.entries.some((e) => e.id === 'process'));
  assert.ok(palette.entries.some((e) => e.id === 'lane'));
});

test('a flowchart entry inserted into a blank diagram seeds the flowchart TD header itself', () => {
  const palette = resolvePaletteKind('');
  const process = palette.entries.find((e) => e.id === 'process');
  assert.equal(process.insert(''), 'flowchart TD\nA[Process]');
  assert.equal(process.insert('   \n '), 'flowchart TD\nA[Process]');
});

// Legacy bracket pairs, not Mermaid v11's unified @{shape:...} syntax — see
// the file-level comment in diagram-palette.js for why this reversed an
// earlier version's choice (readability/consistency with hand-written and
// template source, both of which use bracket pairs everywhere).
test('flowchart shape entries append a classic bracket-shape node with a fresh id', () => {
  const palette = resolvePaletteKind('flowchart TD\n  A --> B');
  const process = palette.entries.find((e) => e.id === 'process');
  const next = process.insert('flowchart TD\n  A --> B');
  assert.equal(next, 'flowchart TD\n  A --> B\nC[Process]');
});

test('flowchart shape entries pick an id that does not collide with existing nodes', () => {
  const palette = resolvePaletteKind('flowchart TD\n  A --> B\n  B --> C');
  const decision = palette.entries.find((e) => e.id === 'decision');
  const next = decision.insert('flowchart TD\n  A --> B\n  B --> C');
  assert.equal(next, 'flowchart TD\n  A --> B\n  B --> C\nD{Decision}');
});

test('flowchart shape entries still avoid colliding with an @{shape:...} node from before this file switched off that syntax', () => {
  const source = 'flowchart TD\n  A --> B\n  C@{ shape: rect, label: "Process" }';
  const palette = resolvePaletteKind(source);
  const decision = palette.entries.find((e) => e.id === 'decision');
  const next = decision.insert(source);
  assert.equal(next, `${source}\nD{Decision}`);
});

test('the Manual Operation (trapezoid) entry uses an asymmetric bracket pair, not a symmetric one', () => {
  const palette = resolvePaletteKind('flowchart TD\n  A --> B');
  const trapezoid = palette.entries.find((e) => e.id === 'manual-operation');
  const next = trapezoid.insert('flowchart TD\n  A --> B');
  assert.equal(next, 'flowchart TD\n  A --> B\nC[/Manual Operation\\]');
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

test('a sequence entry seeds the sequenceDiagram header itself if ever invoked against a blank source', () => {
  // resolvePaletteKind('') always defaults to 'flowchart' (the most common
  // type), so a real click can't reach this exact combination — but
  // insert() is a plain function of whatever source it's given, so this
  // covers the same ensureHeader defensiveness the flowchart entries have.
  const palette = resolvePaletteKind('sequenceDiagram\n  participant A\n  A->>A: noop');
  const participant = palette.entries.find((e) => e.id === 'participant');
  assert.equal(participant.insert(''), 'sequenceDiagram\nparticipant A');
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
