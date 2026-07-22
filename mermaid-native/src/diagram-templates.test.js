import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIAGRAM_TEMPLATES, templateById } from './diagram-templates.js';

test('every template has a unique id, a label, and non-empty source', () => {
  const ids = new Set();
  for (const t of DIAGRAM_TEMPLATES) {
    assert.ok(t.id && typeof t.id === 'string');
    assert.ok(!ids.has(t.id), `duplicate template id: ${t.id}`);
    ids.add(t.id);
    assert.ok(t.label && typeof t.label === 'string');
    assert.ok(t.source && t.source.trim().length > 0);
  }
});

test('templateById finds a known template by id', () => {
  const flowchart = templateById('flowchart');
  assert.ok(flowchart);
  assert.equal(flowchart.label, 'Flowchart');
  assert.match(flowchart.source, /^flowchart/);
});

test('templateById returns null for an unknown id', () => {
  assert.equal(templateById('does-not-exist'), null);
  assert.equal(templateById(undefined), null);
});

test('mindmap and architecture-beta are deliberately excluded pending real-browser verification', () => {
  // See diagram-templates.js's header comment — a jsdom spike couldn't
  // confirm mindmap's canvas-based layout completes, and architecture-beta
  // was never checked at all. Don't add either without running that check.
  assert.ok(!DIAGRAM_TEMPLATES.some((t) => t.id === 'mindmap'));
  assert.ok(!DIAGRAM_TEMPLATES.some((t) => t.id === 'architecture'));
});
