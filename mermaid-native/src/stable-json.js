/**
 * Deterministic JSON serialization used to compare "is this the same data",
 * not "is this the same bytes". Plain `JSON.stringify` output depends on
 * object key insertion order, which isn't something Jira's entity-property
 * storage guarantees to preserve round-trip — if it ever reformats or
 * reorders keys, naive string comparison would report a false conflict on
 * every ordinary save. Sorting keys before serializing removes that
 * assumption instead of relying on it being true.
 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = canonicalize(value[key]);
        return acc;
      }, {});
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}
