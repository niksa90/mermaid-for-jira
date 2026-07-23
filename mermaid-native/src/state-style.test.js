import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isStateDiagramSource,
  parseStateIds,
  parseStateStyles,
  upsertStateStyle,
  getStateLabelText,
  setStateLabelText,
} from './state-style.js';

test('isStateDiagramSource recognizes both stateDiagram and stateDiagram-v2', () => {
  assert.equal(isStateDiagramSource('stateDiagram-v2\n  [*] --> A'), true);
  assert.equal(isStateDiagramSource('stateDiagram\n  [*] --> A'), true);
  assert.equal(isStateDiagramSource('flowchart TD\n  A --> B'), false);
});

test('parseStateIds finds transition endpoints, excluding the [*] pseudostate', () => {
  const source = 'stateDiagram-v2\n  [*] --> A\n  A --> B\n  B --> [*]';
  assert.deepEqual(parseStateIds(source), ['A', 'B']);
});

test('parseStateIds finds state declarations (bare, aliased, composite)', () => {
  const source = [
    'stateDiagram-v2',
    'state A',
    'state "Some description" as B',
    'state C {',
    '  [*] --> D',
    '}',
  ].join('\n');
  const ids = parseStateIds(source);
  assert.ok(ids.includes('A'));
  assert.ok(ids.includes('B'));
  assert.ok(ids.includes('C'));
  assert.ok(ids.includes('D'));
});

test('parseStateIds finds a <<choice>>/<<fork>>/<<join>> pseudostate declaration', () => {
  const source = 'stateDiagram-v2\n  state choice1 <<choice>>\n  state fork1 <<fork>>';
  const ids = parseStateIds(source);
  assert.ok(ids.includes('choice1'));
  assert.ok(ids.includes('fork1'));
});

test('parseStateIds excludes reserved keywords', () => {
  const ids = parseStateIds('stateDiagram-v2\n  [*] --> A\n  A --> [*]');
  assert.ok(!ids.includes('stateDiagram-v2'));
});

test('upsertStateStyle creates a classDef + class pair when neither exists', () => {
  const source = 'stateDiagram-v2\n  [*] --> A\n  A --> [*]';
  const next = upsertStateStyle(source, 'A', { fill: '#f00' });
  assert.equal(
    next,
    'stateDiagram-v2\n  [*] --> A\n  A --> [*]\nclassDef nodeStyle_A fill:#f00\nclass A nodeStyle_A'
  );
});

test('parseStateStyles reads back only this picker\'s own dedicated classDefs', () => {
  const source = [
    'stateDiagram-v2',
    '[*] --> A',
    'classDef nodeStyle_A fill:#f00,stroke:#333',
    'class A nodeStyle_A',
    'classDef someHandwrittenClass fill:#0f0',
    'class A someHandwrittenClass',
  ].join('\n');
  assert.deepEqual(parseStateStyles(source), { A: { fill: '#f00', stroke: '#333' } });
});

test('upsertStateStyle merges into the existing pair without touching other hand-written classes', () => {
  const source = [
    'stateDiagram-v2',
    '[*] --> A',
    'classDef nodeStyle_A fill:#f00',
    'class A nodeStyle_A',
    'classDef someHandwrittenClass fill:#0f0',
    'class A someHandwrittenClass',
  ].join('\n');
  const next = upsertStateStyle(source, 'A', { stroke: '#333' });
  assert.ok(next.includes('classDef nodeStyle_A fill:#f00,stroke:#333'));
  assert.ok(next.includes('classDef someHandwrittenClass fill:#0f0'));
  assert.ok(next.includes('class A someHandwrittenClass'));
});

test('upsertStateStyle removes both lines once every channel is cleared', () => {
  const source = [
    'stateDiagram-v2',
    '[*] --> A',
    'classDef nodeStyle_A fill:#f00,stroke:#333',
    'class A nodeStyle_A',
  ].join('\n');
  const next = upsertStateStyle(source, 'A', { fill: '', stroke: '' });
  assert.equal(next, 'stateDiagram-v2\n[*] --> A');
});

test('upsertStateStyle supports the stroke-width (border width) channel', () => {
  const source = 'stateDiagram-v2\n[*] --> A';
  const next = upsertStateStyle(source, 'A', { 'stroke-width': '6' });
  assert.equal(
    next,
    'stateDiagram-v2\n[*] --> A\nclassDef nodeStyle_A stroke-width:6\nclass A nodeStyle_A'
  );
});

// The generated classDef/class syntax's validity against the real Mermaid
// parser was checked manually (`mermaid` is only a dependency of the inner
// static/main-custom-ui package, not this outer one `npm test` runs from,
// so it can't be cross-imported here) — confirmed stateDiagram-v2 rejects
// flowchart-style `style StateId fill:...` outright but accepts
// classDef/class, which is why this module uses that mechanism instead.

// getStateLabelText / setStateLabelText: the double-click-to-edit-text
// gesture's state-diagram backend, covering both real syntax forms
// (confirmed via a jsdom scratch render of the real mermaid parser — an
// empty quoted alias, `state "" as Id`, is a parse error, unlike ER's empty
// quoted relationship label).
test('getStateLabelText reads an alias or a colon-description, empty string for neither', () => {
  assert.equal(getStateLabelText('stateDiagram-v2\n  state "Long Name" as s1\n  s1 --> s2', 's1'), 'Long Name');
  assert.equal(getStateLabelText('stateDiagram-v2\n  s2 : Short description\n  s1 --> s2', 's2'), 'Short description');
  assert.equal(getStateLabelText('stateDiagram-v2\n  A --> B', 'A'), '');
});

test('setStateLabelText rewrites an existing alias in place', () => {
  const source = 'stateDiagram-v2\n  state "Long Name" as s1\n  s1 --> s2';
  assert.equal(
    setStateLabelText(source, 's1', 'New Name'),
    'stateDiagram-v2\n  state "New Name" as s1\n  s1 --> s2'
  );
});

test('setStateLabelText rewrites an existing colon-description in place', () => {
  const source = 'stateDiagram-v2\n  s2 : Short description\n  s1 --> s2';
  assert.equal(setStateLabelText(source, 's2', 'New description'), 'stateDiagram-v2\n  s2 : New description\n  s1 --> s2');
});

test('setStateLabelText synthesizes a new colon-description line for a state with neither form yet', () => {
  const source = 'stateDiagram-v2\n  A --> B';
  assert.equal(setStateLabelText(source, 'A', 'Idle'), 'stateDiagram-v2\n  A --> B\nA : Idle');
});

test('setStateLabelText clears an alias by removing the line entirely, not writing an invalid empty-quoted alias', () => {
  const source = 'stateDiagram-v2\n  state "Long Name" as s1\n  s1 --> s2';
  assert.equal(setStateLabelText(source, 's1', ''), 'stateDiagram-v2\n  s1 --> s2');
});

test('setStateLabelText clears a colon-description by removing the line entirely', () => {
  const source = 'stateDiagram-v2\n  s2 : Short description\n  s1 --> s2';
  assert.equal(setStateLabelText(source, 's2', ''), 'stateDiagram-v2\n  s1 --> s2');
});
