// Pure logic for the click/drag-to-connect gesture (DiagramCanvas.jsx) and
// the edge popover it opens (App.jsx): turns "the user dragged (or
// click-clicked) from node A's handle to node B" into an appended Mermaid
// edge/relationship/transition/message line, and reads/rewrites/deletes an
// existing one by its two endpoints (or, for sequence, by ordinal — see
// below).
//
// Covers flowchart, state, class, ER, and sequence. Sequence needed its own
// pass rather than reusing this file's endpoint-based shape wholesale —
// confirmed via a jsdom scratch render (mermaid@11.16.0) that its DOM scheme
// is genuinely different from the other four, not just a variant of it:
// - Every participant/actor's own TOP box carries `data-et="participant"` +
//   `data-id="<sourceId>"` directly (an alias, e.g. `participant A as
//   Alice Cooper`, still renders `data-id="A"` — the short id, matching
//   what a message line actually references). No `<marker>-<sourceId>-
//   <counter>` id-string to parse (see svg-node-id.js) — DiagramCanvas.jsx
//   reads the attribute straight off the element for sequence rather than
//   going through extractClickedNodeId. The BOTTOM mirror box (rendered a
//   second time at the diagram's end) carries no such attributes at all,
//   which is why the connect gesture's hover/click target is the top box
//   specifically, not "either occurrence of this participant."
// - Each message renders as `data-et="message"` `data-from="<id>"`
//   `data-to="<id>"` directly on the element — no id-parsing needed at all
//   (better than every other diagram type's scheme, which all require
//   extracting endpoints from a synthesized id string). A self-message
//   (`A->>A: ...`) renders as an SVG `<path>` instead of a `<line>` — same
//   attributes, different tag, so any code touching these elements can't
//   assume a specific tag name.
// - "Connecting" two participants means appending an ordered *message*, not
//   an unordered edge/relationship. Deletion/restyle-by-endpoints doesn't
//   work for messages the way it does for flowchart/class/ER, because two
//   messages can share the exact same (from, to) pair (e.g. a request and
//   its reply going the other way, or two same-direction messages in a
//   loop) — messages are identified by ordinal position among message
//   lines instead (see parseSequenceMessages), the same "position, not
//   endpoints" approach state-diagram transitions already use for their own
//   different reason (no endpoint info in their DOM id at all). Confirmed
//   via jsdom that a message's DOM order (and its own internal
//   `data-id="i<N>"` counter, which also numbers loop/alt/opt/par
//   boundaries and so isn't a dense 0..count-1 sequence) both increase
//   strictly in source order even across loop/alt/opt/par nesting — so a
//   plain "Nth message-shaped line in the source, top to bottom, ignoring
//   any control-structure keyword lines" ordinal lines up with "Nth
//   `[data-et="message"]` element in the DOM," without needing to replicate
//   Mermaid's own internal counter.
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

// Sequence message arrow variants offered by the connect gesture's edge
// popover: every combination of solid/dotted line and none/arrow/cross/async
// arrowhead Mermaid's sequence grammar supports — confirmed via a jsdom
// scratch render that all 8 parse and render distinctly (matching Mermaid's
// own docs' naming for these, not just something inferred from the syntax).
// Ordered longest-syntax-first for buildSequenceArrowPattern below, same
// "more specific alternative must get first crack" rule as CLASS_ARROWS —
// `-->>`  is a strict superset-in-prefix of `->>`/`-->`, so a shorter
// alternative earlier in the pattern could otherwise win first and leave a
// dangling character the rest of the regex fails to match.
export const SEQUENCE_ARROWS = [
  { id: 'solid', label: 'Solid', syntax: '->' },
  { id: 'solid-arrow', label: 'Solid, arrow', syntax: '->>' },
  { id: 'solid-cross', label: 'Solid, cross', syntax: '-x' },
  { id: 'solid-async', label: 'Solid, async', syntax: '-)' },
  { id: 'dotted', label: 'Dotted', syntax: '-->' },
  { id: 'dotted-arrow', label: 'Dotted, arrow', syntax: '-->>' },
  { id: 'dotted-cross', label: 'Dotted, cross', syntax: '--x' },
  { id: 'dotted-async', label: 'Dotted, async', syntax: '--)' },
];

function sequenceArrowPattern() {
  return [...SEQUENCE_ARROWS]
    .sort((a, b) => b.syntax.length - a.syntax.length)
    .map((a) => escapeRegex(a.syntax))
    .join('|');
}

function sequenceMessageRegex() {
  return new RegExp(`^(\\s*)([A-Za-z_]\\w*)\\s*(${sequenceArrowPattern()})\\s*([A-Za-z_]\\w*)\\s*:\\s*(.*)$`);
}

const DEFAULT_ER_LABEL = 'relates to';

// ER labels containing a space fail to parse unless quoted — confirmed via
// the real parser (a bare `A ||--o{ B : relates to` is a parse error, but
// `: "relates to"` and `: relates` both parse). Always quoting sidesteps
// having to detect "does this specific label need it" and matches what a
// single-word label looks like quoted anyway (also confirmed to parse).
function quoteErLabel(label) {
  return `"${(label || '').replace(/"/g, '')}"`;
}

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
  if (kind === 'sequence')
    return { kind, arrowOptions: SEQUENCE_ARROWS, needsLabel: false, defaultArrowId: 'solid-arrow' };
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
    line = `${fromId} ${arrow.syntax} ${toId} : ${quoteErLabel(opts.label || DEFAULT_ER_LABEL)}`;
  } else if (connectKind.kind === 'sequence') {
    // Always appended at the end, never inserted mid-diagram or into an
    // existing loop/alt/opt/par block — "a new message happens last" is the
    // one unambiguous place to put it without guessing which block (if any)
    // the user meant. Auto-declares both participants if either is new
    // (confirmed against the real parser — no explicit participant/actor
    // line is required), same as diagram-palette.js's own message-inserting
    // entries.
    const arrow =
      SEQUENCE_ARROWS.find((a) => a.id === (opts.arrowId || connectKind.defaultArrowId)) || SEQUENCE_ARROWS[0];
    line = `${fromId}${arrow.syntax}${toId}: ${opts.label || 'message'}`;
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

function flowchartEdgeLineRegex(fromId, toId) {
  return new RegExp(
    `^\\s*${fromId}${SHAPE_GROUP}\\s*(${FLOWCHART_ARROW})\\s*(?:\\|([^|]*)\\|\\s*)?${toId}${SHAPE_GROUP}\\s*$`
  );
}

/**
 * Returns the current arrow-label text for the flowchart edge connecting
 * fromId -> toId (`''` if it has none), or `null` if no line matches at
 * all (edge no longer exists in this exact shape). Preserves the line's
 * existing shapes and arrow style (solid/dotted/thick/...) — only the
 * `|label|` portion is inspected/rewritten by this and setFlowchartEdgeLabel.
 */
export function readFlowchartEdgeLabel(source, fromId, toId) {
  const lines = (source || '').split('\n');
  for (const line of lines) {
    const m = line.match(flowchartEdgeLineRegex(fromId, toId));
    if (m) return m[3] || '';
  }
  return null;
}

/**
 * Rewrites the flowchart edge connecting fromId -> toId in place, setting
 * (or clearing) its `|label|`. Preserves both ends' shapes and the arrow's
 * own style — only the label changes. No-op if no line matches (same
 * "best-effort, doesn't touch a line it doesn't fully recognize" tradeoff
 * as deleteFlowchartEdge — a chained multi-arrow line is left untouched
 * rather than partially rewritten).
 */
export function setFlowchartEdgeLabel(source, fromId, toId, label) {
  const lines = (source || '').split('\n');
  const re = flowchartEdgeLineRegex(fromId, toId);
  const idx = lines.findIndex((line) => re.test(line));
  if (idx === -1) return source || '';
  const [, fromShape = '', arrow, , toShape = ''] = lines[idx].match(re);
  lines[idx] = label
    ? `${fromId}${fromShape} ${arrow}|${label}| ${toId}${toShape}`
    : `${fromId}${fromShape} ${arrow} ${toId}${toShape}`;
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

const STATE_TRANSITION_RE = /^(\[\*\]|[A-Za-z_]\w*)\s*-->\s*(\[\*\]|[A-Za-z_]\w*)\s*(?::\s*(.*))?$/;

/**
 * Returns `{ fromId, toId, label }` for the Nth transition line (0-based,
 * same source-order indexing as deleteStateEdge), or `null` if out of
 * range.
 */
export function readStateEdgeAtIndex(source, edgeIndex) {
  if (edgeIndex == null || edgeIndex < 0) return null;
  const lines = (source || '').split('\n');
  let count = -1;
  for (const line of lines) {
    const m = line.trim().match(STATE_TRANSITION_RE);
    if (!m) continue;
    count += 1;
    if (count === edgeIndex) return { fromId: m[1], toId: m[2], label: m[3] || '' };
  }
  return null;
}

/** Rewrites the Nth transition line (0-based) to set (or clear) its `: label`. No-op if `edgeIndex` is out of range. */
export function setStateEdgeLabelAtIndex(source, edgeIndex, label) {
  const current = readStateEdgeAtIndex(source, edgeIndex);
  if (!current) return source || '';
  const lines = (source || '').split('\n');
  let count = -1;
  const idx = lines.findIndex((line) => {
    if (!STATE_TRANSITION_RE.test(line.trim())) return false;
    count += 1;
    return count === edgeIndex;
  });
  if (idx === -1) return source || '';
  lines[idx] = label ? `${current.fromId} --> ${current.toId} : ${label}` : `${current.fromId} --> ${current.toId}`;
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

// Matches either a quoted (`"..."`) or bare label — reading has to accept
// both since a hand-typed diagram might use either, even though this app's
// own writes always emit the quoted form (see quoteErLabel above).
const ER_LABEL_GROUP = '(?:"([^"]*)"|([^\\s][^\\r\\n]*)?)';

function erEdgeRegex(fromId, toId) {
  const cardPattern = ER_CARDINALITIES.map((a) => escapeRegex(a.syntax)).join('|');
  return new RegExp(`^\\s*${fromId}\\s*(?:${cardPattern})\\s*${toId}\\s*:\\s*${ER_LABEL_GROUP}\\s*$`);
}

/** Returns `{ arrowId, label }` for the ER relationship line connecting fromId -> toId, or null if none is found. */
export function readErEdge(source, fromId, toId) {
  const lines = (source || '').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    for (const card of ER_CARDINALITIES) {
      const re = new RegExp(`^${fromId}\\s*${escapeRegex(card.syntax)}\\s*${toId}\\s*:\\s*${ER_LABEL_GROUP}$`);
      const m = trimmed.match(re);
      if (m) return { arrowId: card.id, label: m[1] ?? m[2] ?? '' };
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
 * use `arrowId`'s cardinality and `label`. Always quotes the label (see
 * quoteErLabel) — deliberately doesn't fall back to a default for an
 * empty/cleared label the way connectNodes does for a brand-new edge: this
 * is called on every keystroke while editing an existing label (see
 * App.jsx's edge popover), and forcing a fallback while the field is
 * genuinely empty (e.g. the user backspaced it to retype) would fight
 * their typing, reappearing between keystrokes. An empty quoted label
 * (`: ""`) is valid Mermaid syntax on its own (confirmed via the real
 * parser). Appends a new line instead if no existing line matched.
 */
export function setErEdge(source, fromId, toId, arrowId, label) {
  const card = ER_CARDINALITIES.find((a) => a.id === arrowId) || ER_CARDINALITIES[0];
  const newLine = `${fromId} ${card.syntax} ${toId} : ${quoteErLabel(label)}`;
  const lines = (source || '').split('\n');
  const idx = lines.findIndex((line) => erEdgeRegex(fromId, toId).test(line));
  if (idx === -1) return [...lines, newLine].join('\n');
  lines[idx] = newLine;
  return lines.join('\n');
}

/**
 * Every message-shaped line in `source`, top to bottom, regardless of
 * indentation or loop/alt/opt/par nesting — a `loop`/`alt`/`else`/`opt`/
 * `par`/`and`/`end`/`Note ...` line never matches this regex, so those are
 * transparently skipped rather than needing to be explicitly excluded.
 * `lineIndex` (this array's own position — NOT Mermaid's internal `i<N>`
 * counter, which also numbers control-structure boundaries and so isn't
 * dense) is what the DOM's ordinal position among `[data-et="message"]`
 * elements lines up with (see this file's header comment) — every other
 * function below identifies a message by this ordinal, not by endpoints,
 * since two messages can share the same (from, to) pair.
 */
export function parseSequenceMessages(source) {
  const re = sequenceMessageRegex();
  const lines = (source || '').split('\n');
  const messages = [];
  lines.forEach((line, sourceLineIndex) => {
    const m = line.match(re);
    if (!m) return;
    messages.push({ fromId: m[2], arrowSyntax: m[3], toId: m[4], label: m[5], sourceLineIndex });
  });
  return messages;
}

/** Returns `{ fromId, toId, label, arrowId }` for the Nth message line (0-based, source order), or `null` if out of range. */
export function readSequenceMessageAtIndex(source, ordinal) {
  if (ordinal == null || ordinal < 0) return null;
  const msg = parseSequenceMessages(source)[ordinal];
  if (!msg) return null;
  const arrow = SEQUENCE_ARROWS.find((a) => a.syntax === msg.arrowSyntax);
  return { fromId: msg.fromId, toId: msg.toId, label: msg.label, arrowId: arrow ? arrow.id : SEQUENCE_ARROWS[0].id };
}

/**
 * Rewrites the Nth message line (0-based) in place, setting its arrow
 * variant and label. Preserves the line's own leading indentation (messages
 * inside a loop/alt/opt/par block are indented in every template/palette
 * entry this app generates) and endpoints — only the arrow syntax and label
 * change. No-op if `ordinal` is out of range.
 */
export function setSequenceMessageAtIndex(source, ordinal, arrowId, label) {
  const messages = parseSequenceMessages(source);
  const msg = messages[ordinal];
  if (!msg) return source || '';
  const arrow = SEQUENCE_ARROWS.find((a) => a.id === arrowId) || SEQUENCE_ARROWS.find((a) => a.syntax === msg.arrowSyntax) || SEQUENCE_ARROWS[0];
  const lines = (source || '').split('\n');
  const original = lines[msg.sourceLineIndex];
  const indent = original.match(/^(\s*)/)[1];
  lines[msg.sourceLineIndex] = `${indent}${msg.fromId}${arrow.syntax}${msg.toId}: ${label}`;
  return lines.join('\n');
}

/** Removes the Nth message line (0-based, source order) from `source`. No-op if `ordinal` is out of range. */
export function deleteSequenceMessageAtIndex(source, ordinal) {
  const messages = parseSequenceMessages(source);
  const msg = messages[ordinal];
  if (!msg) return source || '';
  const lines = (source || '').split('\n');
  lines.splice(msg.sourceLineIndex, 1);
  return lines.join('\n');
}
