import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  withTheme,
  safeDiagramId,
  readableParseError,
  parseInlineStyleAttr,
  MERMAID_THEMES,
} from './mermaid-renderer.js';

test('withTheme leaves source untouched for the default theme', () => {
  const source = 'flowchart TD\n  A --> B';
  assert.equal(withTheme(source, 'default'), source);
  assert.equal(withTheme(source, undefined), source);
});

test('withTheme prepends an init directive for non-default themes', () => {
  const source = 'flowchart TD\n  A --> B';
  const themed = withTheme(source, 'dark');
  assert.match(themed, /^%%\{init: \{"theme": "dark"\}\}%%\n/);
  assert.match(themed, /flowchart TD/);
});

test('withTheme trims and handles empty source', () => {
  assert.equal(withTheme('   ', 'dark'), '');
  assert.equal(withTheme('', 'default'), '');
});

test('every exposed theme is a real option, not the blank-slate "base" theme', () => {
  // 'base' renders almost colorless without custom themeVariables (which
  // this app doesn't support yet) — picking it as a plain menu item would
  // look broken, not like a style choice. See mermaid-renderer.js.
  assert.ok(!MERMAID_THEMES.includes('base'));
});

test('safeDiagramId always starts with a letter, even with a numeric prefix', () => {
  // The historical bug: diagram ids are derived from Date.now(), and
  // Mermaid internally does querySelector('#' + id) — a leading digit
  // there is an invalid CSS identifier (querySelector('#123...') throws)
  // and crashes the render instead of showing the diagram.
  const id = safeDiagramId('1784561175265-abc123', 0);
  assert.match(id, /^[a-zA-Z][a-zA-Z0-9_-]*$/);
});

test('safeDiagramId includes the prefix and index for traceability', () => {
  const id = safeDiagramId('abc', 3);
  assert.match(id, /^d-abc-3-/);
});

test('readableParseError collapses whitespace and caps length', () => {
  const err = { str: 'line one\n\nline   two\nline three'.repeat(20) };
  const message = readableParseError(err);
  assert.ok(message.length <= 300);
  assert.ok(!message.includes('\n'));
});

test('readableParseError falls back to message or String(err)', () => {
  assert.equal(readableParseError({ message: 'boom' }), 'boom');
  assert.equal(readableParseError('plain string error'), 'plain string error');
});

// This is the bug behind "custom style X fill:#... colors don't render":
// Mermaid writes per-node `style` directives as a style="..." attribute
// directly on the element (a separate code path from the theme's <style>
// block), and it must be parsed the same way so it can be converted to a
// presentation attribute — otherwise it's just dead markup once Forge's CSP
// drops the inline style attribute.
test('parseInlineStyleAttr splits declarations on the mermaid "style X fill:...,stroke:...,color:..." shape', () => {
  assert.deepEqual(parseInlineStyleAttr('fill:#00c853,stroke:#000,color:#fff'.replace(/,/g, ';')), {
    fill: '#00c853',
    stroke: '#000',
    color: '#fff',
  });
});

test('parseInlineStyleAttr ignores empty/malformed declarations', () => {
  assert.deepEqual(parseInlineStyleAttr('fill:#fff;; stroke : #000 ;bogus'), {
    fill: '#fff',
    stroke: '#000',
  });
});

test('parseInlineStyleAttr handles empty input', () => {
  assert.deepEqual(parseInlineStyleAttr(''), {});
  assert.deepEqual(parseInlineStyleAttr(undefined), {});
});
