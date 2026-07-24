import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  withTheme,
  safeDiagramId,
  readableParseError,
  extractErrorLine,
  parseInlineStyleAttr,
  MERMAID_THEMES,
  isDarkMermaidTheme,
  ensureXlinkNamespaceDeclared,
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

test('isDarkMermaidTheme is true only for the "dark" theme', () => {
  assert.equal(isDarkMermaidTheme('dark'), true);
  assert.equal(isDarkMermaidTheme('default'), false);
  assert.equal(isDarkMermaidTheme('neutral'), false);
  assert.equal(isDarkMermaidTheme('forest'), false);
});

test('every exposed theme is a real option, not the blank-slate "base" theme', () => {
  // Raw 'base' renders almost colorless without custom themeVariables —
  // picking it as a plain menu item would look broken, not like a style
  // choice. 'brand' is that same base theme with the overrides applied, so
  // it doesn't need a separate 'base' entry alongside it. See
  // mermaid-renderer.js.
  assert.ok(!MERMAID_THEMES.includes('base'));
  assert.ok(MERMAID_THEMES.includes('brand'));
});

test('withTheme expands "brand" into a base-theme init directive with themeVariables and a top-level fontFamily', () => {
  const source = 'flowchart TD\n  A --> B';
  const themed = withTheme(source, 'brand');
  const initJson = themed.match(/^%%\{init: (.+)\}%%\n/)[1];
  const init = JSON.parse(initJson);
  assert.equal(init.theme, 'base');
  // Must be top-level, not nested in themeVariables — Mermaid silently
  // ignores a nested fontFamily instead of erroring (confirmed against the
  // real mermaid package), so this would otherwise regress invisibly.
  assert.ok(init.fontFamily.includes('Inter'));
  assert.ok(init.themeVariables.primaryColor);
  assert.equal(init.themeVariables.fontFamily, undefined);
  assert.match(themed, /flowchart TD/);
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

// Real message shape confirmed against mermaid v11.16.0 via a jsdom scratch
// render (see mermaid-renderer.js's extractErrorLine comment) — jison's
// parsers across flowchart/state/sequence all format it this way.
test('extractErrorLine reads the line number out of a real Mermaid parse error', () => {
  const err = {
    message:
      "Parse error on line 4:\n...--> B[End  B --> C\n---------------------^\nExpecting 'SQE', got '1'",
  };
  assert.equal(extractErrorLine(err), 4);
});

test('extractErrorLine falls back to null when no line number is present', () => {
  assert.equal(extractErrorLine({ message: 'Diagram is empty.' }), null);
  assert.equal(extractErrorLine({}), null);
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

// Regression coverage for the C4Context rendering bug: a real browser's
// XMLSerializer can emit an <image>'s `href` back out as the legacy
// `xlink:href` qualified name after a parse->serialize round trip, without
// ever declaring the xmlns:xlink namespace that qualified name needs — see
// reserializeWithXlinkNamespace()'s own comment in mermaid-renderer.js for
// why this can't be reproduced/verified end-to-end under jsdom.
test('ensureXlinkNamespaceDeclared adds the missing declaration when xlink: is used but undeclared', () => {
  const input = '<svg><image href="x" xlink:href="data:image/png;base64,AAA"/></svg>';
  const result = ensureXlinkNamespaceDeclared(input);
  assert.match(result, /^<svg xmlns:xlink="http:\/\/www\.w3\.org\/1999\/xlink">/);
  assert.match(result, /xlink:href="data:image\/png;base64,AAA"/);
});

test('ensureXlinkNamespaceDeclared leaves the string untouched when xlink: is already declared', () => {
  const input = '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="x"/></svg>';
  assert.equal(ensureXlinkNamespaceDeclared(input), input);
});

test('ensureXlinkNamespaceDeclared leaves the string untouched when no xlink: attribute is present', () => {
  const input = '<svg><image href="x"/></svg>';
  assert.equal(ensureXlinkNamespaceDeclared(input), input);
});
