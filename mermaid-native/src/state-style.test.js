import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isStateDiagramSource,
  parseStateIds,
  parseStateStyles,
  upsertStateStyle,
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

// The generated classDef/class syntax's validity against the real Mermaid
// parser was checked manually (`mermaid` is only a dependency of the inner
// static/main-custom-ui package, not this outer one `npm test` runs from,
// so it can't be cross-imported here) — confirmed stateDiagram-v2 rejects
// flowchart-style `style StateId fill:...` outright but accepts
// classDef/class, which is why this module uses that mechanism instead.
