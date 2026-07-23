// Maps a rendered SVG node <g>'s own `id` attribute back to the
// diagram-kind + source node/state/entity id it came from, for the
// click-on-the-bubble style popover (DiagramCanvas.jsx).
//
// Verified against real mermaid@11.16.0 output via a jsdom scratch render
// (not assumed from docs), the same verification convention as everything
// else in this project: Mermaid always emits a per-node group id as
// `<renderId>-<marker>-<sourceId>-<counter>`, where `<renderId>` is the id
// passed into mermaid.render() (see safeDiagramId in mermaid-renderer.js)
// and marker is 'flowchart' for flowchart nodes, 'state' for state-diagram
// states, and 'entity' for ER entities. `<renderId>` can itself contain
// hyphens (it's built from Date.now()-derived diagram ids), so the marker
// token is located by substring search rather than a generic split on '-'.
//
// Only these three markers exist because only these three diagram types
// have a per-element style mechanism at all (see node-style-kind.js) — a
// click on a sequence/pie/gantt/kanban/mindmap element (or on an edge/label
// within any diagram) simply won't match any marker, and callers should
// treat that as "nothing to style here", not an error.
const MARKERS = [
  { marker: 'flowchart', kind: 'flowchart' },
  { marker: 'state', kind: 'state' },
  { marker: 'entity', kind: 'er' },
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
