// Maps a rendered SVG node <g>'s own `id` attribute back to the
// diagram-kind + source node/state/entity/class id it came from, for the
// click-on-the-bubble style popover and the click/drag-to-connect gesture
// (DiagramCanvas.jsx).
//
// Verified against real mermaid@11.16.0 output via a jsdom scratch render
// (not assumed from docs), the same verification convention as everything
// else in this project: Mermaid always emits a per-node group id as
// `<renderId>-<marker>-<sourceId>-<counter>`, where `<renderId>` is the id
// passed into mermaid.render() (see safeDiagramId in mermaid-renderer.js)
// and marker is 'flowchart' for flowchart nodes, 'state' for state-diagram
// states, 'entity' for ER entities, and 'classId' for class-diagram
// classes. `<renderId>` can itself contain hyphens (it's built from
// Date.now()-derived diagram ids), so the marker token is located by
// substring search rather than a generic split on '-'.
//
// A click on a sequence/pie/gantt/kanban/mindmap element (or on a label
// within any diagram) simply won't match any marker, and callers should
// treat that as "nothing to style/connect here", not an error.
const MARKERS = [
  { marker: 'flowchart', kind: 'flowchart' },
  { marker: 'state', kind: 'state' },
  { marker: 'entity', kind: 'er' },
  { marker: 'classId', kind: 'class' },
];

/**
 * Returns `{ kind, nodeId }` for a clicked node group's DOM id, or `null` if
 * the id doesn't match any known per-diagram-type marker (e.g. it's an edge,
 * a cluster/subgraph wrapper, or a diagram type with no style mechanism).
 */
export function extractClickedNodeId(domId) {
  if (!domId) return null;
  for (const { marker, kind } of MARKERS) {
    const token = `-${marker}-`;
    const idx = domId.indexOf(token);
    if (idx === -1) continue;
    const rest = domId.slice(idx + token.length);
    if (!rest) continue;
    // Strip Mermaid's trailing per-node render counter (e.g. "A-0" -> "A").
    // Source node ids are restricted to [A-Za-z_]\w* by every parser here,
    // which can't itself end in "-<digits>", so this can't misfire by
    // stripping part of a real id.
    const match = rest.match(/^(.*)-\d+$/);
    const nodeId = match ? match[1] : rest;
    if (nodeId) return { kind, nodeId };
  }
  return null;
}

/**
 * Returns `{ fromId, toId }` for a clicked flowchart edge's DOM id (used by
 * diagram-connect.js's arrow-deletion), or `null` if `domId` isn't a
 * flowchart edge. Mermaid emits these as
 * `<renderId>-L_<fromId>_<toId>_<counter>` (confirmed via a jsdom scratch
 * render of a real flowchart, same convention as extractClickedNodeId
 * above) — state-diagram edges don't carry their endpoints in the id at
 * all (just `<renderId>-edge<N>`), which is exactly why arrow deletion is
 * flowchart-only for now, same scope as connectNodes/isConnectable.
 *
 * Splits `fromId_toId` on the *first* underscore, so a from-id containing
 * its own underscore would misresolve — this app's own templates/palette
 * only ever generate short alphanumeric ids, so this is the same
 * "best-effort, doesn't cover every possible hand-typed id" tradeoff as
 * every other regex-based parser in this app family, not a full parser.
 */
export function extractClickedEdgeId(domId) {
  if (!domId) return null;
  const token = '-L_';
  const idx = domId.indexOf(token);
  if (idx === -1) return null;
  const rest = domId.slice(idx + token.length); // e.g. "A_B_0"
  const withoutCounter = rest.replace(/_\d+$/, '');
  const underscoreIdx = withoutCounter.indexOf('_');
  if (underscoreIdx === -1) return null;
  const fromId = withoutCounter.slice(0, underscoreIdx);
  const toId = withoutCounter.slice(underscoreIdx + 1);
  return fromId && toId ? { fromId, toId } : null;
}

/**
 * Returns `{ fromId, toId }` for a clicked class-diagram relationship's DOM
 * id, or `null`. Mermaid emits these as
 * `<renderId>-id_<fromId>_<toId>_<counter>` (confirmed via jsdom scratch
 * render) — unlike flowchart's `-L_`, there's no token separating fromId
 * from toId, so `knownClassIds` (the diagram's own declared class names,
 * from diagram-connect.js's parseClassIds) is required to find the correct
 * split point. Best-effort: if more than one split matches (e.g. two
 * declared classes whose names make either split valid) or none does,
 * returns null rather than guessing — same "doesn't cover every possible
 * hand-typed id" tradeoff as extractClickedEdgeId above.
 */
export function extractClickedClassEdgeId(domId, knownClassIds) {
  if (!domId) return null;
  const token = '-id_';
  const idx = domId.indexOf(token);
  if (idx === -1) return null;
  const rest = domId.slice(idx + token.length).replace(/_\d+$/, '');
  const known = new Set(knownClassIds || []);
  const parts = rest.split('_');
  const matches = [];
  for (let i = 1; i < parts.length; i += 1) {
    const fromId = parts.slice(0, i).join('_');
    const toId = parts.slice(i).join('_');
    if (known.has(fromId) && known.has(toId)) matches.push({ fromId, toId });
  }
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Returns `{ fromId, toId }` for a clicked ER relationship's DOM id, or
 * `null`. Mermaid emits these as
 * `<renderId>-id_entity-<FromName>-<n>_entity-<ToName>-<m>_<counter>` —
 * each endpoint is itself a full per-node rendered id fragment (see the
 * 'entity' marker above), not the bare entity name, joined by the literal
 * token `_entity-` (confirmed via jsdom scratch render) — splitting on that
 * exact token is reliable even when an entity name itself contains a
 * hyphen (e.g. "LINE-ITEM"), unlike the class case above.
 */
export function extractClickedErEdgeId(domId) {
  if (!domId) return null;
  const token = '-id_';
  const idx = domId.indexOf(token);
  if (idx === -1) return null;
  const rest = domId.slice(idx + token.length).replace(/_\d+$/, '');
  const splitToken = '_entity-';
  const splitIdx = rest.indexOf(splitToken);
  if (splitIdx === -1) return null;
  const fromChunk = rest.slice(0, splitIdx);
  const toChunk = `entity-${rest.slice(splitIdx + splitToken.length)}`;
  const fromName = fromChunk.match(/^entity-(.+)-\d+$/)?.[1];
  const toName = toChunk.match(/^entity-(.+)-\d+$/)?.[1];
  return fromName && toName ? { fromId: fromName, toId: toName } : null;
}

/**
 * Returns the 0-based transition index for a clicked state-diagram edge's
 * DOM id (`<renderId>-edge<N>`), or `null`. Unlike flowchart/class/ER,
 * state edges carry no endpoint info at all in their id (confirmed via
 * jsdom scratch render — `data-id` is a bare `edge0`/`edge1`/...) — this
 * positional index is matched against the Nth transition line in source
 * order instead (see diagram-connect.js's deleteStateEdge).
 */
export function extractClickedStateEdgeIndex(domId) {
  if (!domId) return null;
  const match = domId.match(/-edge(\d+)$/);
  return match ? Number(match[1]) : null;
}
