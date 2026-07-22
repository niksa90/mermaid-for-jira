import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractClickedNodeId } from './svg-node-id.js';

test('extracts a flowchart node id, stripping the render-id prefix and counter suffix', () => {
  assert.deepEqual(extractClickedNodeId('d-1737-abc123-0-x7f3a2-flowchart-A-0'), {
    kind: 'flowchart',
    nodeId: 'A',
  });
});

test('extracts a state-diagram state id', () => {
  assert.deepEqual(extractClickedNodeId('d-1737-abc123-0-x7f3a2-state-Running-3'), {
    kind: 'state',
    nodeId: 'Running',
  });
});

test('extracts an ER entity id', () => {
  assert.deepEqual(extractClickedNodeId('d-1737-abc123-0-x7f3a2-entity-CUSTOMER-0'), {
    kind: 'er',
    nodeId: 'CUSTOMER',
  });
});

test('a node id whose source id itself contains digits still strips only the trailing counter', () => {
  assert.deepEqual(extractClickedNodeId('renderid-flowchart-node1-12'), {
    kind: 'flowchart',
    nodeId: 'node1',
  });
});

test('returns null for an id with no known marker (e.g. an edge or cluster wrapper)', () => {
  assert.equal(extractClickedNodeId('renderid-cluster-subGraph0-0'), null);
});

test('returns null for a nullish/empty id', () => {
  assert.equal(extractClickedNodeId(null), null);
  assert.equal(extractClickedNodeId(''), null);
});
