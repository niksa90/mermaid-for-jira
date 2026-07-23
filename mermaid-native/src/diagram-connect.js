// Pure logic for the click/drag-to-connect gesture (DiagramCanvas.jsx):
// turns "the user dragged (or click-clicked) from node A's handle to node
// B" into an appended Mermaid edge line, the same "append a line" pattern
// diagram-palette.js and node-label.js's setNodeIcon already use.
//
// Flowchart-only for this pass — deliberately not extended to
// sequence/state/class/ER yet. Sequence is a genuinely different model
// (messages are ordered by source position, not "connect any two things
// anywhere"); class/ER have multiple semantically-different relationship
// arrows (inheritance/composition/aggregation/association; cardinality
// combinations), which need their own arrow-style picker as part of that
// work rather than a single default arrow — deferred to when those
// diagram types get their own connect support, not built blind now.
//
// Confirmed against the real mermaid@11.16.0 parser (jsdom scratch spike,
// same convention as every other diagram-syntax decision in this app):
// connecting a previously-isolated node into the rest of the graph can
// visibly reflow every other node's position (dagre recomputes the whole
// layout from scratch on any source change) — an inherent, accepted
// tradeoff of Mermaid's auto-layout, not a bug to work around, and no
// different from what already happens on every other edit (DiagramCanvas
// already resets pan/zoom to 100% on any `svg` change, connect included).

/** True if `source` is a flowchart/graph — the only diagram type Connect supports right now. */
export function isConnectable(source) {
  const firstContentLine = (source || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('%%'));
  return !!firstContentLine && /^(flowchart|graph)\b/.test(firstContentLine);
}

/**
 * Appends `fromId --> toId` to a flowchart's source. Returns `source`
 * unchanged (a no-op, not an error) for a self-connection — connecting a
 * node to itself isn't a meaningful gesture result here, unlike Mermaid's
 * own support for genuine self-loop edges typed by hand.
 */
export function connectNodes(source, fromId, toId) {
  if (!fromId || !toId || fromId === toId) return source || '';
  const lines = (source || '').split('\n');
  const trimmed = lines.length && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
  return [...trimmed, `${fromId} --> ${toId}`].join('\n');
}
