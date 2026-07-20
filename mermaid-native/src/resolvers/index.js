import ResolverModule from '@forge/resolver';
import api, { route } from '@forge/api';

// @forge/resolver is CommonJS; under native ESM ("type": "module") the
// default import resolves to the whole `module.exports` object rather than
// its `.default`, so unwrap it explicitly instead of relying on interop.
const Resolver = ResolverModule.default || ResolverModule;

const resolver = new Resolver();
const PROPERTY_KEY = 'mermaid-diagram-board';

resolver.define('getFieldValue', async (req) => {
  const { issueKey } = req.payload;
  const res = await api
    .asUser()
    .requestJira(route`/rest/api/3/issue/${issueKey}/properties/${PROPERTY_KEY}`);

  if (res.status === 404) {
    return { diagrams: [] };
  }
  const body = await res.json();
  return body.value || { diagrams: [] };
});

resolver.define('setFieldValue', async (req) => {
  const { issueKey, value } = req.payload;
  await api
    .asUser()
    .requestJira(route`/rest/api/3/issue/${issueKey}/properties/${PROPERTY_KEY}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
  return { ok: true };
});

export const handler = resolver.getDefinitions();
