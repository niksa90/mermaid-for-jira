// Click-to-insert shape/element palette: each entry appends a new,
// unconnected Mermaid declaration to the diagram's source, using a freshly
// generated id so it never collides with what's already there. Deliberately
// text-insertion-only — it never wires up edges or lets you drag onto the
// canvas (that's the much larger "hover a node, get a floating toolbar,
// Connect" idea from the same feedback round, scoped separately). Follows
// the exact "append a line" pattern node-label.js's setNodeIcon already
// established for the icon picker's own synthesized-line fallback.
//
// Every snippet below was confirmed to parse against the real `mermaid`
// package (v11.16.0, the version this app ships) via a one-off jsdom
// scratch spike before being added here — same "verify against the real
// parser, not docs/memory" convention as every other diagram-syntax
// decision in this app (see mermaid-renderer.js/node-style.js's own
// history). Flowchart entries specifically use Mermaid v11's unified node
// syntax (`Id@{ shape: name, label: "..." }`) rather than the legacy
// per-shape bracket pairs (`[...]`, `([...])`, `(((...)))`, ...) — both
// still parse, but the legacy forms have shape-specific bracket nesting
// that's easy to generate wrong programmatically, where the unified form
// is one uniform template for every shape.
import { detectDiagramKind } from './diagram-kind.js';
import { parseFlowchartNodeIds } from './node-style.js';

function appendLines(source, newLines) {
  const lines = (source || '').split('\n');
  const trimmed = lines.length && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
  return [...trimmed, ...newLines].join('\n');
}

// A completely empty diagram (a freshly-cleared editor, not the "Add a
// diagram" flow, which already seeds a blank flowchart template) has no
// diagram-type keyword for detectDiagramKind to find, so every entry's
// insert() has to supply one itself rather than appending a shape/element
// line with no header above it — real Mermaid syntax, not a fragment. Only
// kicks in when the source is genuinely blank; an existing diagram of this
// same type is left completely untouched.
function ensureHeader(source, header) {
  return (source || '').trim() ? source : header;
}

/**
 * First unused id from A, B, C, ... Z, then A2, B2, ... — deliberately the
 * same short single-letter convention this app's own flowchart/sequence/ER
 * templates already use (diagram-templates.js), rather than inventing a new
 * id style just for palette-inserted elements.
 */
export function nextAvailableId(existingIds) {
  const used = new Set(existingIds || []);
  for (let suffix = 1; suffix < 100; suffix += 1) {
    for (let i = 0; i < 26; i += 1) {
      const candidate = suffix === 1 ? String.fromCharCode(65 + i) : `${String.fromCharCode(65 + i)}${suffix}`;
      if (!used.has(candidate)) return candidate;
    }
  }
  // Exhausted A..Z99 — practically unreachable (2600 ids), but a diagram
  // this size would already be well past Jira's 32KB entity-property
  // limit long before this ever triggers.
  return `N${Date.now()}`;
}

// Best-effort extraction of sequence participant/actor ids — same
// "regex, not a real parser, misses unusual syntax without breaking
// anything" caveat as node-style.js's parseFlowchartNodeIds.
function parseSequenceIds(source) {
  const ids = [];
  (source || '').split('\n').forEach((line) => {
    const m = line.trim().match(/^(?:participant|actor)\s+([A-Za-z_]\w*)/);
    if (m && !ids.includes(m[1])) ids.push(m[1]);
  });
  return ids;
}

// A curated subset of Mermaid v11's ~30 unified shape names (confirmed via
// the shape registry in node_modules/mermaid/dist/chunks/mermaid.core/
// chunk-*.mjs) — matching the "curated set, not everything Mermaid
// supports" convention already used for QUICK_SWATCHES/QUICK_ICONS.
// "Start/End" deliberately uses `circle`, matching the user's own mockup
// literally, rather than the more textbook stadium/rounded terminal shape.
const FLOWCHART_SHAPES = [
  { id: 'process', label: 'Process', glyph: '□', shape: 'rect' },
  { id: 'decision', label: 'Decision', glyph: '◇', shape: 'diamond' },
  { id: 'start-end', label: 'Start/End', glyph: '○', shape: 'circle' },
  { id: 'database', label: 'Database', glyph: 'database', shape: 'cyl' },
  { id: 'subroutine', label: 'Subroutine', glyph: 'subroutine', shape: 'subroutine' },
  { id: 'input-output', label: 'Input/Output', glyph: '▱', shape: 'lean-r' },
  { id: 'document', label: 'Document', glyph: 'document', shape: 'doc' },
  { id: 'hexagon', label: 'Preparation', glyph: '⬡', shape: 'hexagon' },
];

function flowchartEntries() {
  const shapeEntries = FLOWCHART_SHAPES.map(({ id, label, glyph, shape }) => ({
    id,
    label,
    glyph,
    insert(source) {
      const base = ensureHeader(source, 'flowchart TD');
      const nodeId = nextAvailableId(parseFlowchartNodeIds(base));
      return appendLines(base, [`${nodeId}@{ shape: ${shape}, label: "${label}" }`]);
    },
  }));

  return [
    ...shapeEntries,
    {
      // Not a node shape — a subgraph block, directly answering "quick
      // adding of ... lanes" from the original request.
      id: 'lane',
      label: 'Lane',
      glyph: 'lane',
      insert(source) {
        const base = ensureHeader(source, 'flowchart TD');
        const laneId = nextAvailableId(parseFlowchartNodeIds(base));
        return appendLines(base, [`subgraph ${laneId}[Lane]`, `end`]);
      },
    },
  ];
}

// The two message endpoints a block/note entry references — reuses the
// diagram's own first two existing participants/actors if there are any,
// so an inserted block visually connects to what's already there instead
// of introducing floating new participants; falls back to fresh ids
// otherwise. Sequence diagrams auto-declare a participant the first time
// it's used in a message (confirmed against the real parser — no explicit
// `participant`/`actor` line is required), so a fresh id works standalone.
function sequenceEndpoints(source) {
  const existing = parseSequenceIds(source);
  if (existing.length >= 2) return [existing[0], existing[1]];
  const first = existing[0] || nextAvailableId([]);
  const second = nextAvailableId([first]);
  return [first, second];
}

function sequenceEntries() {
  return [
    {
      id: 'participant',
      label: 'Participant',
      glyph: 'participant',
      insert(source) {
        const base = ensureHeader(source, 'sequenceDiagram');
        return appendLines(base, [`participant ${nextAvailableId(parseSequenceIds(base))}`]);
      },
    },
    {
      id: 'actor',
      label: 'Actor',
      glyph: 'actor',
      insert(source) {
        const base = ensureHeader(source, 'sequenceDiagram');
        return appendLines(base, [`actor ${nextAvailableId(parseSequenceIds(base))}`]);
      },
    },
    {
      id: 'loop',
      label: 'Loop',
      glyph: '↻',
      insert(source) {
        const base = ensureHeader(source, 'sequenceDiagram');
        const [a, b] = sequenceEndpoints(base);
        return appendLines(base, [`loop Every message`, `    ${a}->>${b}: message`, `end`]);
      },
    },
    {
      id: 'alt',
      label: 'Alt/Else',
      glyph: '⑂',
      insert(source) {
        const base = ensureHeader(source, 'sequenceDiagram');
        const [a, b] = sequenceEndpoints(base);
        return appendLines(base, [
          `alt condition`,
          `    ${a}->>${b}: message`,
          `else`,
          `    ${a}->>${b}: alternative`,
          `end`,
        ]);
      },
    },
    {
      id: 'opt',
      label: 'Opt',
      glyph: '?',
      insert(source) {
        const base = ensureHeader(source, 'sequenceDiagram');
        const [a, b] = sequenceEndpoints(base);
        return appendLines(base, [`opt condition`, `    ${a}->>${b}: message`, `end`]);
      },
    },
    {
      id: 'par',
      label: 'Par',
      glyph: '∥',
      insert(source) {
        const base = ensureHeader(source, 'sequenceDiagram');
        const [a, b] = sequenceEndpoints(base);
        return appendLines(base, [
          `par action one`,
          `    ${a}->>${b}: one`,
          `and action two`,
          `    ${a}->>${b}: two`,
          `end`,
        ]);
      },
    },
    {
      id: 'note',
      label: 'Note',
      glyph: '✎',
      insert(source) {
        const base = ensureHeader(source, 'sequenceDiagram');
        const [a, b] = sequenceEndpoints(base);
        return appendLines(base, [`Note over ${a},${b}: a note`]);
      },
    },
  ];
}

const PALETTE_BUILDERS = {
  flowchart: flowchartEntries,
  sequence: sequenceEntries,
};

/**
 * Resolves the click-to-insert palette for whichever diagram type `source`
 * is, or null if this diagram type has no palette yet — mirrors
 * node-style-kind.js's resolveNodeStyleKind dispatch shape, including its
 * "return null = nothing to offer" convention (callers should render
 * nothing, not an empty palette).
 *
 * A blank source (an emptied-out editor — "Add a diagram" already seeds a
 * real flowchart template, so this is specifically the "user deleted
 * everything" case) has no diagram-type keyword for detectDiagramKind to
 * find, which used to mean the palette row disappeared at exactly the
 * moment it would have been most useful — a real bug report, not a
 * hypothetical. Defaulting to 'flowchart' here (each entry's insert()
 * itself supplies the `flowchart TD` header via ensureHeader above) lets
 * the palette double as a way to start a diagram from nothing.
 */
export function resolvePaletteKind(source) {
  const kind = (source || '').trim() ? detectDiagramKind(source) : 'flowchart';
  const builder = PALETTE_BUILDERS[kind];
  if (!builder) return null;
  return { kind, entries: builder() };
}
