import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractClickedNodeId,
  extractClickedEdgeId,
  extractClickedClassEdgeId,
  extractClickedErEdgeId,
  extractClickedStateEdgeIndex,
} from './svg-node-id.js';

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

test('extractClickedEdgeId extracts both endpoints of a flowchart edge, stripping the counter', () => {
  assert.deepEqual(extractClickedEdgeId('dedge-L_A_B_0'), { fromId: 'A', toId: 'B' });
});

test('extractClickedEdgeId returns null for a node id, or anything with no -L_ marker', () => {
  assert.equal(extractClickedEdgeId('d-1737-abc123-0-x7f3a2-flowchart-A-0'), null);
  assert.equal(extractClickedEdgeId('renderid-cluster-subGraph0-0'), null);
  assert.equal(extractClickedEdgeId(null), null);
});

test('extracts a class-diagram node id', () => {
  assert.deepEqual(extractClickedNodeId('dclass-classId-Animal-0'), {
    kind: 'class',
    nodeId: 'Animal',
  });
});

test('extractClickedClassEdgeId splits the two endpoints using the diagram\'s known class ids', () => {
  assert.deepEqual(extractClickedClassEdgeId('dclass-id_Animal_Dog_1', ['Animal', 'Dog', 'Cat']), {
    fromId: 'Animal',
    toId: 'Dog',
  });
  assert.deepEqual(extractClickedClassEdgeId('dclass-id_Animal_Cat_2', ['Animal', 'Dog', 'Cat']), {
    fromId: 'Animal',
    toId: 'Cat',
  });
});

test('extractClickedClassEdgeId returns null when the ids are unknown or the id has no -id_ marker', () => {
  assert.equal(extractClickedClassEdgeId('dclass-id_Animal_Dog_1', []), null);
  assert.equal(extractClickedClassEdgeId('dclass-classId-Animal-0', ['Animal', 'Dog']), null);
  assert.equal(extractClickedClassEdgeId(null, ['Animal', 'Dog']), null);
});

test('extractClickedErEdgeId splits two full entity-id endpoints, even when a name contains a hyphen', () => {
  assert.deepEqual(extractClickedErEdgeId('der-id_entity-CUSTOMER-0_entity-ORDER-1_0'), {
    fromId: 'CUSTOMER',
    toId: 'ORDER',
  });
  assert.deepEqual(extractClickedErEdgeId('der-id_entity-ORDER-1_entity-LINE-ITEM-2_1'), {
    fromId: 'ORDER',
    toId: 'LINE-ITEM',
  });
});

test('extractClickedErEdgeId returns null for anything with no -id_ marker or malformed endpoints', () => {
  assert.equal(extractClickedErEdgeId('der-entity-CUSTOMER-0'), null);
  assert.equal(extractClickedErEdgeId(null), null);
});

test('extractClickedStateEdgeIndex reads the 0-based counter from a state edge id', () => {
  assert.equal(extractClickedStateEdgeIndex('dstate-edge0'), 0);
  assert.equal(extractClickedStateEdgeIndex('dstate-edge12'), 12);
});

test('extractClickedStateEdgeIndex returns null for anything with no -edge<N> suffix', () => {
  assert.equal(extractClickedStateEdgeIndex('dstate-state-A-0'), null);
  assert.equal(extractClickedStateEdgeIndex(null), null);
});
