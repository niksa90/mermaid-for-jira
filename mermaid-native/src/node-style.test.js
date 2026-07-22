import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isFlowchartSource,
  parseFlowchartNodeIds,
  parseNodeStyles,
  upsertNodeStyle,
} from './node-style.js';

test('isFlowchartSource recognizes flowchart and graph, ignoring a leading %%init directive', () => {
  assert.equal(isFlowchartSource('flowchart TD\n  A --> B'), true);
  assert.equal(isFlowchartSource('graph LR\n  A --> B'), true);
  assert.equal(
    isFlowchartSource('%%{init: {"theme": "dark"}}%%\nflowchart TD\n  A --> B'),
    true
  );
  assert.equal(isFlowchartSource('sequenceDiagram\n  Alice->>Bob: Hi'), false);
  assert.equal(isFlowchartSource(''), false);
});

test('parseFlowchartNodeIds finds bracket-declared nodes', () => {
  const source = 'flowchart TD\n  A[Start] --> B(Round)\n  B --> C{Diamond}';
  assert.deepEqual(parseFlowchartNodeIds(source), ['A', 'B', 'C']);
});

test('parseFlowchartNodeIds finds edge-only nodes with no shape declaration', () => {
  const source = 'flowchart TD\n  A --> B\n  B --> C';
  assert.deepEqual(parseFlowchartNodeIds(source), ['A', 'B', 'C']);
});

test('parseFlowchartNodeIds handles edge labels', () => {
  const source = 'flowchart TD\n  A -->|Yes| B\n  A -.->|No| C';
  assert.deepEqual(parseFlowchartNodeIds(source), ['A', 'B', 'C']);
});

test('parseFlowchartNodeIds excludes reserved keywords like the diagram type and direction', () => {
  const source = 'flowchart TD\n  A[Start] --> B[End]';
  const ids = parseFlowchartNodeIds(source);
  assert.ok(!ids.includes('flowchart'));
  assert.ok(!ids.includes('TD'));
});

test('parseNodeStyles reads existing style directives', () => {
  const source = 'flowchart TD\n  A[Start]\n  style A fill:#f00,stroke:#333,color:#fff';
  assert.deepEqual(parseNodeStyles(source), {
    A: { fill: '#f00', stroke: '#333', color: '#fff' },
  });
});

test('upsertNodeStyle appends a new style line when none exists', () => {
  const source = 'flowchart TD\n  A[Start] --> B[End]';
  const next = upsertNodeStyle(source, 'A', { fill: '#00ff00' });
  assert.equal(next, 'flowchart TD\n  A[Start] --> B[End]\nstyle A fill:#00ff00');
});

test('upsertNodeStyle merges into an existing style line without clobbering other channels', () => {
  const source = 'flowchart TD\n  A[Start]\n  style A fill:#f00,stroke:#333';
  const next = upsertNodeStyle(source, 'A', { color: '#fff' });
  assert.equal(next, 'flowchart TD\n  A[Start]\n  style A fill:#f00,stroke:#333,color:#fff');
});

test('upsertNodeStyle overwrites a channel already set', () => {
  const source = 'flowchart TD\n  A[Start]\n  style A fill:#f00';
  const next = upsertNodeStyle(source, 'A', { fill: '#0f0' });
  assert.equal(next, 'flowchart TD\n  A[Start]\n  style A fill:#0f0');
});

test('upsertNodeStyle removes the style line entirely once every channel is cleared', () => {
  const source = 'flowchart TD\n  A[Start]\n  style A fill:#f00,stroke:#333';
  const next = upsertNodeStyle(source, 'A', { fill: '', stroke: '' });
  assert.equal(next, 'flowchart TD\n  A[Start]');
});

test('upsertNodeStyle clearing a channel that was never set on an unstyled node is a no-op', () => {
  const source = 'flowchart TD\n  A[Start]';
  const next = upsertNodeStyle(source, 'A', { fill: '', stroke: '', color: '' });
  assert.equal(next, source);
});

test('upsertNodeStyle supports the stroke-width (border width) channel, ordered between stroke and color', () => {
  const source = 'flowchart TD\n  A[Start]';
  const next = upsertNodeStyle(source, 'A', { stroke: '#333', 'stroke-width': '6', color: '#fff' });
  assert.equal(next, 'flowchart TD\n  A[Start]\nstyle A stroke:#333,stroke-width:6,color:#fff');
});

test('parseNodeStyles reads back a stroke-width directive', () => {
  const source = 'flowchart TD\n  A[Start]\n  style A stroke-width:4';
  assert.deepEqual(parseNodeStyles(source), { A: { 'stroke-width': '4' } });
});
