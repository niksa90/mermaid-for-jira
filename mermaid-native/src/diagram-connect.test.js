import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isConnectable, connectNodes, deleteEdge } from './diagram-connect.js';

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

test('deleteEdge removes a bare edge line entirely', () => {
  const source = 'flowchart TD\n  A --> B\n  B --> C';
  assert.equal(deleteEdge(source, 'A', 'B'), 'flowchart TD\n  B --> C');
});

// The app's own default new-diagram template combines a node declaration
// with its edge on one line — deleting the edge must not also discard the
// shape/label that happened to share the line with it.
test('deleteEdge splits a combined declaration+edge line, preserving both shapes', () => {
  const source = 'flowchart TD\n  A[Start] --> B[End]';
  assert.equal(deleteEdge(source, 'A', 'B'), 'flowchart TD\nA[Start]\nB[End]');
});

test('deleteEdge preserves only the side(s) that actually had a shape on that line', () => {
  const source = 'flowchart TD\n  B -->|Yes| C[Do the thing]';
  assert.equal(deleteEdge(source, 'B', 'C'), 'flowchart TD\nC[Do the thing]');
});

test('deleteEdge is a no-op when no line is exactly that edge (e.g. a chained arrow line)', () => {
  const source = 'flowchart TD\n  A --> B --> C';
  assert.equal(deleteEdge(source, 'A', 'B'), source);
});

test('deleteEdge is a no-op if the edge does not exist', () => {
  const source = 'flowchart TD\n  A --> B';
  assert.equal(deleteEdge(source, 'A', 'C'), source);
});
