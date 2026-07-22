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
