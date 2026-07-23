import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugifyFilename } from './diagram-export.js';

test('slugifyFilename lowercases and hyphenates a normal title', () => {
  assert.equal(slugifyFilename('Deployment Flow'), 'deployment-flow');
});

test('slugifyFilename collapses runs of punctuation/whitespace into one hyphen', () => {
  assert.equal(slugifyFilename('  Q3   Plan!! (v2) '), 'q3-plan-v2');
});

test('slugifyFilename strips leading/trailing hyphens left by stripped punctuation', () => {
  assert.equal(slugifyFilename('-- Untitled --'), 'untitled');
});

test('slugifyFilename falls back to "diagram" for empty, whitespace-only, or non-string input', () => {
  assert.equal(slugifyFilename(''), 'diagram');
  assert.equal(slugifyFilename('   '), 'diagram');
  assert.equal(slugifyFilename(undefined), 'diagram');
  assert.equal(slugifyFilename(null), 'diagram');
});
