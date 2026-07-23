// Pure logic for the click/drag-to-connect gesture (DiagramCanvas.jsx) and
// the edge popover it opens (App.jsx): turns "the user dragged (or
// click-clicked) from node A's handle to node B" into an appended Mermaid
// edge/relationship/transition line, and reads/rewrites/deletes an existing
// one by its two endpoints.
//
// Covers flowchart, state, class, and ER. Sequence diagrams are
// deliberately NOT covered here — confirmed via a jsdom scratch render that
// classic `participant` declarations render with no `id` at all (just a
// `name` attribute), unlike every other diagram type's clean
// `<marker>-<sourceId>-<counter>` id scheme (see svg-node-id.js), and
// "connecting" two participants means appending an ordered *message*, not
// an unordered edge — different enough on both ends (click-detection *and*
// what "connect" produces) that it needs its own pass rather than forcing
// it through this module's shape.
//
// Confirmed against the real mermaid@11.16.0 parser (jsdom scratch spike,
// same convention as every other diagram-syntax decision in this app):
// connecting a previously-isolated node into the rest of the graph can
// visibly reflow every other node's position (dagre recomputes the whole
// layout from scratch on any source change) — an inherent, accepted
// tradeoff of Mermaid's auto-layout, not a bug to work around, and no
// different from what already happens on every other edit (DiagramCanvas
// already resets pan/zoom to 100% on any `svg` change, connect included).
import { detectDiagramKind } from './diagram-kind.js';

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Class-diagram relationship arrows offered by the connect gesture's edge
// popover. Each syntax confirmed to parse via the real mermaid parser.
// Ordered longest-token-first for the delete/read regexes below, same
// "more specific alternative must get first crack" rule as node-label.js's
// BRACKET_SHAPES.
export const CLASS_ARROWS = [
  { id: 'inheritance', label: 'Inheritance', syntax: '<|--' },
  { id: 'realization', label: 'Realization', syntax: '..|>' },
  { id: 'composition', label: 'Composition', syntax: '*--' },
  { id: 'aggregation', label: 'Aggregation', syntax: 'o--' },
  { id: 'dependency', label: 'Dependency', syntax: '..>' },
  { id: 'association', label: 'Association', syntax: '-->' },
  { id: 'link', label: 'Link (solid)', syntax: '--' },
];

// ER relationship cardinalities offered by the connect gesture's edge
// popover. ER relationships REQUIRE a label — confirmed via the real
// parser that a bare `A ||--o{ B` with no `: label` at all fails to parse
// (unlike class/state, where a label is always optional) — so connect
// always inserts a placeholder label the user can edit from the popover.
export const ER_CARDINALITIES = [
  { id: 'one-to-many', label: 'One to many', syntax: '||--o{' },
  { id: 'one-to-one', label: 'One to one', syntax: '||--||' },
  { id: 'zero-or-one-to-many', label: 'Zero/one to many', syntax: '|o--o{' },
  { id: 'many-to-many', label: 'Many to many', syntax: '}o--o{' },
  { id: 'one-or-more-to-one-or-more', label: 'One-or-more to one-or-more', syntax: '}|--|{' },
  { id: 'zero-or-one-to-zero-or-one', label: 'Zero/one to zero/one', syntax: '|o--o|' },
];

const DEFAULT_ER_LABEL = 'relates to';

/**
 * Resolves what the connect gesture can offer for `source`'s diagram type,
 * or `null` if this diagram type has no connect support at all. Mirrors
 * node-style-kind.js's resolveNodeStyleKind dispatch shape ("return null =
 * nothing to offer").
 */
export function resolveConnectKind(source) {
  const kind = detectDiagramKind(source);
  if (kind === 'flowchart') return { kind, arrowOptions: null, needsLabel: false, defaultArrowId: null };
  if (kind === 'state') return { kind, arrowOptions: null, needsLabel: false, defaultArrowId: null };
  if (kind === 'class') return { kind, arrowOptions: CLASS_ARROWS, needsLabel: false, defaultArrowId: 'association' };
  if (kind === 'er') return { kind, arrowOptions: ER_CARDINALITIES, needsLabel: true, defaultArrowId: 'one-to-many' };
  return null;
}

/** True if `source`'s diagram type supports the connect gesture at all. */
export function isConnectable(source) {
  return !!resolveConnectKind(source);
}

/**
 * Best-effort extraction of declared class names: `class Foo` / `class Foo {`
 * declarations and either endpoint of a relationship line. Regex-based, same
 * "best-effort" caveat as node-style.js's parseFlowchartNodeIds — needed here
 * only to disambiguate a class-relationship DOM id's two endpoints (see
 * extractClickedClassEdgeId in svg-node-id.js), not for a style picker.
 */
export function parseClassIds(source) {
  const text = source || '';
  const ids = new Set();
  const relationRe = new RegExp(
    `^([A-Za-z_]\\w*)\\s*(?:${CLASS_ARROWS.map((a) => escapeRegex(a.syntax)).join('|')})\\s*([A-Za-z_]\\w*)`
  );
  text.split('\n').forEach((line) => {
    const trimmed = line.trim();
    const classMatch = trimmed.match(/^class\s+([A-Za-z_]\w*)/);
    if (classMatch) {
      ids.add(classMatch[1]);
      return;
    }
    const relMatch = trimmed.match(relationRe);
    if (relMatch) {
      ids.add(relMatch[1]);
      ids.add(relMatch[2]);
    }
  });
  return [...ids];
}

// Mermaid's two start/end-of-diagram pseudostate nodes both render under
// these fixed ids (confirmed via jsdom scratch render), regardless of the
// state diagram's own content — `[*]` itself never appears as a rendered
// node id, so a connect gesture touching either has to translate back.
const STATE_PSEUDO_IDS = new Set(['root_start', 'root_end']);
function toStateSourceId(nodeId) {
  return STATE_PSEUDO_IDS.has(nodeId) ? '[*]' : nodeId;
}

/**
 * Appends a new edge/relationship/transition line connecting `fromId` to
 * `toId`, using whichever syntax `source`'s diagram type needs. Returns
 * `source` unchanged (a no-op, not an error) for a self-connection or a
 * diagram type the connect gesture doesn't support.
 *
 * `opts.arrowId` picks a class/ER arrow variant (defaults to
 * resolveConnectKind's defaultArrowId); `opts.label` sets the edge label
 * (ER: falls back to a placeholder since ER relationships require one;
 * class: omitted entirely if not given, since class labels are optional).
 */
export function connectNodes(source, fromId, toId, opts = {}) {
  if (!fromId || !toId || fromId === toId) return source || '';
  const connectKind = resolveConnectKind(source);
  if (!connectKind) return source || '';

  const lines = (source || '').split('\n');
  const trimmed = lines.length && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;

  let line;
  if (connectKind.kind === 'state') {
    line = `${toStateSourceId(fromId)} --> ${toStateSourceId(toId)}`;
  } else if (connectKind.kind === 'class') {
    const arrow = CLASS_ARROWS.find((a) => a.id === (opts.arrowId || connectKind.defaultArrowId)) || CLASS_ARROWS[0];
    line = opts.label ? `${fromId} ${arrow.syntax} ${toId} : ${opts.label}` : `${fromId} ${arrow.syntax} ${toId}`;
  } else if (connectKind.kind === 'er') {
    const arrow =
      ER_CARDINALITIES.find((a) => a.id === (opts.arrowId || connectKind.defaultArrowId)) || ER_CARDINALITIES[0];
    line = `${fromId} ${arrow.syntax} ${toId} : ${opts.label || DEFAULT_ER_LABEL}`;
  } else {
    line = `${fromId} --> ${toId}`;
  }
  return [...trimmed, line].join('\n');
}

// Longer/more-specific bracket pairs first, same ordering rule
// node-label.js's BRACKET_SHAPES comment documents.
const SHAPE_GROUP =
  '(\\[\\[[^\\]]*\\]\\]|\\[\\([^)]*\\)\\]|\\(\\([^)]*\\)\\)|\\{\\{[^}]*\\}\\}|\\[[^\\]]*\\]|\\([^)]*\\)|\\{[^}]*\\})?';
const FLOWCHART_ARROW = '(?:<)?[-=.]{2,}[ox>]?';

/**
 * Removes the flowchart edge connecting fromId -> toId from `source`. Only
 * matches a line whose *entire* trimmed content is that one edge
 * expression (optionally with a shape/label attached to either end, and an
 * optional `|label|` on the arrow) — deliberately not a mid-line splice, so
 * a line combining a node declaration with the edge (this app's own
 * default new-diagram template, `A[Start] --> B[End]`) isn't at risk of a
 * chained multi-arrow line (`A --> B --> C`) being partially, incorrectly
 * rewritten. A chained line like that simply won't match here (same
 * "best-effort, doesn't touch what it doesn't fully recognize" convention
 * as node-style.js's parsers) — clicking that edge is a no-op, not a
 * corruption.
 *
 * Deleting the edge never discards a node's own shape/label: if either side
 * had one on this exact line, it's preserved as its own standalone
 * declaration line rather than disappearing along with the connector.
 */
export function deleteFlowchartEdge(source, fromId, toId) {
  if (!fromId || !toId) return source || '';
  const lines = (source || '').split('\n');
  const re = new RegExp(
    `^\\s*${fromId}${SHAPE_GROUP}\\s*${FLOWCHART_ARROW}\\s*(?:\\|[^|]*\\|\\s*)?${toId}${SHAPE_GROUP}\\s*$`
  );

  const lineIndex = lines.findIndex((line) => re.test(line));
  if (lineIndex === -1) return source || '';

  const [, fromShape, toShape] = lines[lineIndex].match(re);
  const replacement = [];
  if (fromShape) replacement.push(`${fromId}${fromShape}`);
  if (toShape) replacement.push(`${toId}${toShape}`);

  lines.splice(lineIndex, 1, ...replacement);
  return lines.join('\n');
}

/**
 * Removes the Nth transition line (0-based, in source order — see
 * extractClickedStateEdgeIndex in svg-node-id.js for why state edges are
 * identified positionally rather than by endpoint) from a state diagram's
 * source. No-op if `edgeIndex` is out of range.
 */
export function deleteStateEdge(source, edgeIndex) {
  if (edgeIndex == null || edgeIndex < 0) return source || '';
  const lines = (source || '').split('\n');
  let count = -1;
  const lineIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    if (/^(\[\*\]|[A-Za-z_]\w*)\s*-->\s*(\[\*\]|[A-Za-z_]\w*)/.test(trimmed)) {
      count += 1;
      return count === edgeIndex;
    }
    return false;
  });
  if (lineIndex === -1) return source || '';
  lines.splice(lineIndex, 1);
  return lines.join('\n');
}

function classEdgeRegex(fromId, toId) {
  const arrowPattern = CLASS_ARROWS.map((a) => escapeRegex(a.syntax)).join('|');
  return new RegExp(`^\\s*${fromId}\\s*(?:${arrowPattern})\\s*${toId}\\s*(?::\\s*(.*))?\\s*$`);
}

/** Returns `{ arrowId, label }` for the class relationship line connecting fromId -> toId, or null if none is found. */
export function readClassEdge(source, fromId, toId) {
  const lines = (source || '').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    for (const arrow of CLASS_ARROWS) {
      const re = new RegExp(`^${fromId}\\s*${escapeRegex(arrow.syntax)}\\s*${toId}\\s*(?::\\s*(.*))?$`);
      const m = trimmed.match(re);
      if (m) return { arrowId: arrow.id, label: m[1] || '' };
    }
  }
  return null;
}

/** Removes the class relationship line connecting fromId -> toId. No-op if none is found. */
export function deleteClassEdge(source, fromId, toId) {
  if (!fromId || !toId) return source || '';
  const lines = (source || '').split('\n');
  const re = classEdgeRegex(fromId, toId);
  const lineIndex = lines.findIndex((line) => re.test(line));
  if (lineIndex === -1) return source || '';
  lines.splice(lineIndex, 1);
  return lines.join('\n');
}

/**
 * Rewrites the class relationship line connecting fromId -> toId in place
 * (preserving its position in the source) to use `arrowId`'s syntax and
 * `label`. Appends a new line instead if no existing line matched.
 */
export function setClassEdge(source, fromId, toId, arrowId, label) {
  const arrow = CLASS_ARROWS.find((a) => a.id === arrowId) || CLASS_ARROWS[0];
  const newLine = label ? `${fromId} ${arrow.syntax} ${toId} : ${label}` : `${fromId} ${arrow.syntax} ${toId}`;
  const lines = (source || '').split('\n');
  const idx = lines.findIndex((line) => classEdgeRegex(fromId, toId).test(line));
  if (idx === -1) return [...lines, newLine].join('\n');
  lines[idx] = newLine;
  return lines.join('\n');
}

function erEdgeRegex(fromId, toId) {
  const cardPattern = ER_CARDINALITIES.map((a) => escapeRegex(a.syntax)).join('|');
  return new RegExp(`^\\s*${fromId}\\s*(?:${cardPattern})\\s*${toId}\\s*:\\s*(.*)\\s*$`);
}

/** Returns `{ arrowId, label }` for the ER relationship line connecting fromId -> toId, or null if none is found. */
export function readErEdge(source, fromId, toId) {
  const lines = (source || '').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    for (const card of ER_CARDINALITIES) {
      const re = new RegExp(`^${fromId}\\s*${escapeRegex(card.syntax)}\\s*${toId}\\s*:\\s*(.*)$`);
      const m = trimmed.match(re);
      if (m) return { arrowId: card.id, label: m[1] || '' };
    }
  }
  return null;
}

/** Removes the ER relationship line connecting fromId -> toId. No-op if none is found. */
export function deleteErEdge(source, fromId, toId) {
  if (!fromId || !toId) return source || '';
  const lines = (source || '').split('\n');
  const re = erEdgeRegex(fromId, toId);
  const lineIndex = lines.findIndex((line) => re.test(line));
  if (lineIndex === -1) return source || '';
  lines.splice(lineIndex, 1);
  return lines.join('\n');
}

/**
 * Rewrites the ER relationship line connecting fromId -> toId in place to
 * use `arrowId`'s cardinality and `label`. ER labels can't be blank (see
 * the module-level comment) — an empty/whitespace `label` falls back to
 * DEFAULT_ER_LABEL rather than writing invalid syntax. Appends a new line
 * instead if no existing line matched.
 */
export function setErEdge(source, fromId, toId, arrowId, label) {
  const card = ER_CARDINALITIES.find((a) => a.id === arrowId) || ER_CARDINALITIES[0];
  const safeLabel = (label || '').trim() || DEFAULT_ER_LABEL;
  const newLine = `${fromId} ${card.syntax} ${toId} : ${safeLabel}`;
  const lines = (source || '').split('\n');
  const idx = lines.findIndex((line) => erEdgeRegex(fromId, toId).test(line));
  if (idx === -1) return [...lines, newLine].join('\n');
  lines[idx] = newLine;
  return lines.join('\n');
}
