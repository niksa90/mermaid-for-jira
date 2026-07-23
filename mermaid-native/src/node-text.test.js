import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getClassLabelText,
  setClassLabelText,
  getParticipantLabelText,
  setParticipantLabelText,
  parseSequenceParticipantIds,
  resolveNodeTextKind,
} from './node-text.js';

test('getClassLabelText reads a bracket display-label, empty string for none', () => {
  assert.equal(getClassLabelText('classDiagram\n  class Animal["Cool Animal"]', 'Animal'), 'Cool Animal');
  assert.equal(getClassLabelText('classDiagram\n  class Animal\n  class Dog', 'Animal'), '');
});

test('setClassLabelText rewrites an existing bracket label in place', () => {
  const source = 'classDiagram\n  class Animal["Cool Animal"]\n  Animal <|-- Dog';
  assert.equal(
    setClassLabelText(source, 'Animal', 'Best Animal'),
    'classDiagram\n  class Animal["Best Animal"]\n  Animal <|-- Dog'
  );
});

test('setClassLabelText synthesizes a new bracket-label line without disturbing an existing members block', () => {
  const source = 'classDiagram\n  class Animal {\n    +String name\n  }';
  assert.equal(
    setClassLabelText(source, 'Animal', 'Cool Animal'),
    'classDiagram\n  class Animal {\n    +String name\n  }\nclass Animal["Cool Animal"]'
  );
});

test('setClassLabelText clears a bracket label by removing the line entirely', () => {
  const source = 'classDiagram\n  class Animal["Cool Animal"]\n  Animal <|-- Dog';
  assert.equal(setClassLabelText(source, 'Animal', ''), 'classDiagram\n  Animal <|-- Dog');
});

test('getParticipantLabelText reads a participant/actor alias, empty string for none', () => {
  assert.equal(getParticipantLabelText('sequenceDiagram\n  participant A as Alice Cooper', 'A'), 'Alice Cooper');
  assert.equal(getParticipantLabelText('sequenceDiagram\n  A->>B: hi', 'A'), '');
});

test('setParticipantLabelText rewrites an existing alias in place, preserving participant vs. actor', () => {
  assert.equal(
    setParticipantLabelText('sequenceDiagram\n  actor A as Alice', 'A', 'Alice Cooper'),
    'sequenceDiagram\n  actor A as Alice Cooper'
  );
});

test('setParticipantLabelText upgrades a bare declaration to the alias form', () => {
  assert.equal(
    setParticipantLabelText('sequenceDiagram\n  participant A\n  A->>B: hi', 'A', 'Alice Cooper'),
    'sequenceDiagram\n  participant A as Alice Cooper\n  A->>B: hi'
  );
});

test('setParticipantLabelText synthesizes a new declaration for a purely auto-declared (message-only) participant', () => {
  assert.equal(
    setParticipantLabelText('sequenceDiagram\n  A->>B: hi', 'A', 'Alice Cooper'),
    'sequenceDiagram\n  A->>B: hi\nparticipant A as Alice Cooper'
  );
});

test('setParticipantLabelText clears an alias back to its bare declaration form', () => {
  assert.equal(
    setParticipantLabelText('sequenceDiagram\n  participant A as Alice Cooper', 'A', ''),
    'sequenceDiagram\n  participant A'
  );
});

test('parseSequenceParticipantIds finds explicit declarations and message-only (auto-declared) ids', () => {
  const source = 'sequenceDiagram\n  participant A\n  A->>B: hi\n  B-->>C: bye';
  assert.deepEqual(parseSequenceParticipantIds(source).sort(), ['A', 'B', 'C']);
});

test('resolveNodeTextKind dispatches flowchart/state/class/sequence to a real label, and ER to isRename mode', () => {
  assert.equal(resolveNodeTextKind('flowchart TD\n  A[Start]').kind, 'flowchart');
  assert.equal(resolveNodeTextKind('flowchart TD\n  A[Start]').isRename, false);
  assert.equal(resolveNodeTextKind('stateDiagram-v2\n  A').kind, 'state');
  assert.equal(resolveNodeTextKind('classDiagram\n  class A').kind, 'class');
  assert.equal(resolveNodeTextKind('sequenceDiagram\n  A->>B: hi').kind, 'sequence');

  const er = resolveNodeTextKind('erDiagram\n  A ||--o{ B : has');
  assert.equal(er.kind, 'er');
  assert.equal(er.isRename, true);
  assert.equal(er.getText('erDiagram\n  A ||--o{ B : has', 'A'), 'A');
});

test('resolveNodeTextKind returns null for a diagram type with no node/participant text at all', () => {
  assert.equal(resolveNodeTextKind('pie title Pets\n  "Dogs" : 40'), null);
});
