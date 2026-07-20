import ResolverModule from '@forge/resolver';
import api, { route } from '@forge/api';
import { stableStringify } from '../stable-json.js';

// @forge/resolver is CommonJS; under native ESM ("type": "module") the
// default import resolves to the whole `module.exports` object rather than
// its `.default`, so unwrap it explicitly instead of relying on interop.
const Resolver = ResolverModule.default || ResolverModule;

const resolver = new Resolver();
const PROPERTY_KEY = 'mermaid-diagram-board';

// Jira Cloud's documented limit for a single entity property value:
// https://developer.atlassian.com/cloud/jira/platform/jira-entity-properties/
const MAX_PROPERTY_BYTES = 32768;

async function readCurrent(issueKey) {
  const res = await api
    .asUser()
    .requestJira(route`/rest/api/3/issue/${issueKey}/properties/${PROPERTY_KEY}`);

  if (res.status === 404) {
    return { diagrams: [] };
  }
  if (!res.ok) {
    throw new Error(`Failed to read saved diagrams (HTTP ${res.status}).`);
  }
  const body = await res.json();
  return body.value || { diagrams: [] };
}

resolver.define('getFieldValue', async (req) => {
  const { issueKey } = req.payload;
  const value = await readCurrent(issueKey);
  // Returned alongside the diagrams so the client can track "what the
  // server currently has" for optimistic-concurrency checks on save,
  // without re-deriving it from its own (possibly locally-normalized) copy.
  // stableStringify, not JSON.stringify: Jira's entity-property store isn't
  // guaranteed to round-trip key order/formatting byte-for-byte, and a raw
  // string comparison would misfire as a false conflict if it doesn't.
  return { ...value, snapshot: stableStringify(value) };
});

resolver.define('setFieldValue', async (req) => {
  const { issueKey, value, baseSnapshot, force } = req.payload;

  // Optimistic concurrency: if the caller told us what it last read from the
  // server (baseSnapshot) and the server's current value has moved on since
  // then, someone else edited this issue's diagrams concurrently. Overwriting
  // blind would silently drop their change, so report the conflict instead
  // and let the client decide (unless it explicitly asked to force-write).
  if (!force && baseSnapshot !== undefined) {
    const current = await readCurrent(issueKey);
    if (stableStringify(current) !== baseSnapshot) {
      return { conflict: true, current };
    }
  }

  const serialized = JSON.stringify(value);
  const sizeBytes = new TextEncoder().encode(serialized).length;
  if (sizeBytes > MAX_PROPERTY_BYTES) {
    throw new Error(
      `These diagrams are too large to save (${(sizeBytes / 1024).toFixed(1)} KB of a ` +
        `${(MAX_PROPERTY_BYTES / 1024).toFixed(0)} KB Jira limit). Remove or shrink a diagram and try again.`
    );
  }

  const res = await api
    .asUser()
    .requestJira(route`/rest/api/3/issue/${issueKey}/properties/${PROPERTY_KEY}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: serialized,
    });

  if (!res.ok) {
    let detail = '';
    try {
      const errBody = await res.json();
      detail = errBody?.errorMessages?.join(' ') || '';
    } catch {
      // Error body wasn't JSON — fall back to just the status.
    }
    throw new Error(`Failed to save diagrams (HTTP ${res.status}).${detail ? ` ${detail}` : ''}`);
  }

  // stableStringify here too, so this snapshot compares correctly against
  // what a future readCurrent()/stableStringify(current) will produce.
  return { ok: true, snapshot: stableStringify(value) };
});

export const handler = resolver.getDefinitions();
