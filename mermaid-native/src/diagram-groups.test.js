import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRenderGroups, moveTargetIndex, moveBounds } from './diagram-groups.js';

function d(id, section = '') {
  return { id, label: id, source: '', theme: 'default', section };
}

test('buildRenderGroups clusters same-section diagrams even when non-members sit between them', () => {
  const diagrams = [d('a', 'Arch'), d('x'), d('b', 'Arch'), d('y')];
  const groups = buildRenderGroups(diagrams);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].type, 'section');
  assert.equal(groups[0].name, 'Arch');
  assert.deepEqual(
    groups[0].items.map((i) => i.diagram.id),
    ['a', 'b']
  );
  assert.equal(groups[1].diagram.id, 'x');
  assert.equal(groups[2].diagram.id, 'y');
});

test('moveTargetIndex swaps a sectioned diagram with its nearest same-section neighbor, skipping non-members', () => {
  // a(Arch), x(standalone), b(Arch), y(standalone)
  const diagrams = [d('a', 'Arch'), d('x'), d('b', 'Arch'), d('y')];
  // Moving "a" down should land on "b"'s slot (index 2), not "x"'s (index 1).
  assert.equal(moveTargetIndex(diagrams, 'a', 1), 2);
  // Moving "b" up should land back on "a"'s slot (index 0), not "x"'s (index 1).
  assert.equal(moveTargetIndex(diagrams, 'b', -1), 0);
});

test('moveTargetIndex returns null at the boundary of a group', () => {
  const diagrams = [d('a', 'Arch'), d('x'), d('b', 'Arch')];
  assert.equal(moveTargetIndex(diagrams, 'a', -1), null); // "a" is first in Arch
  assert.equal(moveTargetIndex(diagrams, 'b', 1), null); // "b" is last in Arch
});

test('moveTargetIndex treats unsectioned diagrams as flat-array-adjacent, unaffected by sections', () => {
  const diagrams = [d('a', 'Arch'), d('x'), d('y'), d('b', 'Arch')];
  assert.equal(moveTargetIndex(diagrams, 'x', 1), 2);
  assert.equal(moveTargetIndex(diagrams, 'x', -1), 0);
});

test('moveBounds reflects group-relative position, not flat-array position', () => {
  // "b" sits at flat index 2 (not first, not last overall) but is the last
  // member of its own section, so it should not be able to move further down.
  const diagrams = [d('a', 'Arch'), d('b', 'Arch'), d('x')];
  assert.deepEqual(moveBounds(diagrams, 'a'), { canUp: false, canDown: true });
  assert.deepEqual(moveBounds(diagrams, 'b'), { canUp: true, canDown: false });
  assert.deepEqual(moveBounds(diagrams, 'x'), { canUp: true, canDown: false });
});
