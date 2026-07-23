import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isConnectable, connectNodes } from './diagram-connect.js';

test('isConnectable recognizes flowchart and graph, ignoring a leading %%init directive', () => {
  assert.equal(isConnectable('flowchart TD\n  A --> B'), true);
  assert.equal(isConnectable('graph LR\n  A --> B'), true);
  assert.equal(isConnectable('%%{init: {"theme": "dark"}}%%\nflowchart TD\n  A --> B'), true);
});

test('isConnectable is false for other diagram types (Connect is flowchart-only for now)', () => {
  assert.equal(isConnectable('sequenceDiagram\n  A->>B: hi'), false);
  assert.equal(isConnectable('stateDiagram-v2\n  [*] --> A'), false);
  assert.equal(isConnectable(''), false);
});

test('connectNodes appends a plain arrow between the two given ids', () => {
  const source = 'flowchart TD\n  A[Start]\n  B[Process]';
  assert.equal(connectNodes(source, 'A', 'B'), 'flowchart TD\n  A[Start]\n  B[Process]\nA --> B');
});

test('connectNodes is a no-op for a self-connection', () => {
  const source = 'flowchart TD\n  A[Start]';
  assert.equal(connectNodes(source, 'A', 'A'), source);
});

test('connectNodes is a no-op if either id is missing', () => {
  const source = 'flowchart TD\n  A[Start]';
  assert.equal(connectNodes(source, '', 'A'), source);
  assert.equal(connectNodes(source, 'A', ''), source);
});
