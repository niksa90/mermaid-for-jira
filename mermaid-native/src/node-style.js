// Pure helpers for the per-node color picker: parsing node ids out of
// flowchart source, reading/writing the `style NodeId fill:...,stroke:...`
// directives Mermaid itself understands (see mermaid-renderer.js's
// inlineSvgStyles, which is what actually renders these under Forge's CSP).
//
// This intentionally only recognizes flowchart/graph syntax — `style
// NodeId ...` is a flowchart-specific directive, and the id-detection
// heuristics below (bracket shapes, arrow adjacency) are written against
// flowchart syntax specifically, not Mermaid's other diagram types.

const RESERVED_WORDS = new Set([
  'flowchart',
  'graph',
  'subgraph',
  'end',
  'style',
  'classDef',
  'class',
  'click',
  'linkStyle',
  'direction',
  'TD',
  'TB',
  'BT',
  'RL',
  'LR',
]);

// Fill/stroke/border-width/text-color are the four channels the picker
// exposes — a deliberate subset of mermaid-renderer.js's full
// STYLE_PROPS_TO_ATTRS whitelist (which also covers opacity, fonts, etc.,
// not exposed as picker controls). stroke-width overrides need
// mermaid-renderer.js's EXPLICIT_STROKE_WIDTH_ATTR marking to survive
// applyModernPolish()'s otherwise-unconditional border-width bump — see
// that file's comments.
const NODE_STYLE_PROPS = ['fill', 'stroke', 'stroke-width', 'color'];

export function isFlowchartSource(source) {
  const firstContentLine = (source || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('%%'));
  return !!firstContentLine && /^(flowchart|graph)\b/.test(firstContentLine);
}

/**
 * Best-effort extraction of node ids from flowchart source: identifiers
 * declared with a shape (`A[Start]`, `A(Round)`, `A{Diamond}`, ...) plus
 * identifiers that only ever appear as an edge endpoint (`A --> B`, with or
 * without an edge label). Regex-based, not a real Mermaid parser, so it can
 * miss unusual syntax (e.g. a subgraph's own `subgraph id[Title]` label) —
 * that just means the picker won't offer that node, not that anything
 * breaks.
 */
export function parseFlowchartNodeIds(source) {
  const text = source || '';
  const ids = new Set();

  text.split('\n').forEach((line) => {
    const m = line.match(/^\s*([A-Za-z_]\w*)\s*[[({>]/);
    if (m) ids.add(m[1]);
  });

  const arrow = '(?:<)?[-=.]{2,}[ox>]?';
  const beforeArrowRe = new RegExp(`([A-Za-z_]\\w*)\\s*${arrow}`, 'g');
  const afterArrowRe = new RegExp(`${arrow}\\s*(?:\\|[^|]*\\|\\s*)?([A-Za-z_]\\w*)`, 'g');
  let match;
  while ((match = beforeArrowRe.exec(text))) ids.add(match[1]);
  while ((match = afterArrowRe.exec(text))) ids.add(match[1]);

  RESERVED_WORDS.forEach((word) => ids.delete(word));
  return Array.from(ids).sort();
}

// Mermaid's `style NodeId fill:#fff,stroke:#333` directive is comma-separated
// — distinct from the semicolon-separated `style="fill:#fff;stroke:#333"`
// SVG attribute mermaid-renderer.js's parseInlineStyleAttr parses. Those are
// two different serializations of the same concept at two different
// stages (source directive vs. rendered SVG attribute), not interchangeable.
function parseStyleDirectiveDecls(declStr) {
  const decls = {};
  (declStr || '').split(',').forEach((part) => {
    const i = part.indexOf(':');
    if (i === -1) return;
    const prop = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (prop && value) decls[prop] = value;
  });
  return decls;
}

function serializeStyleDirectiveDecls(decls) {
  return NODE_STYLE_PROPS.filter((prop) => decls[prop])
    .map((prop) => `${prop}:${decls[prop]}`)
    .join(',');
}

function nodeStyleLineRe(nodeId) {
  return new RegExp(`^(\\s*)style\\s+${nodeId}\\s+(.*)$`);
}

/** Map of nodeId -> { fill?, stroke?, color? } for every `style NodeId ...` line already in the source. */
export function parseNodeStyles(source) {
  const result = {};
  (source || '').split('\n').forEach((line) => {
    const m = line.match(/^\s*style\s+([A-Za-z_]\w*)\s+(.*)$/);
    if (!m) return;
    result[m[1]] = parseStyleDirectiveDecls(m[2]);
  });
  return result;
}

/**
 * Merges `patch` (any of fill/stroke/color; an empty/falsy value clears
 * that channel) into nodeId's existing `style` line, adding one if none
 * exists yet, or removing the line entirely if the merge leaves no
 * channels set.
 */
export function upsertNodeStyle(source, nodeId, patch) {
  const lines = (source || '').split('\n');
  const re = nodeStyleLineRe(nodeId);
  let lineIndex = -1;
  let indent = '';
  let existingDecls = {};
  lines.forEach((line, i) => {
    if (lineIndex === -1) {
      const m = line.match(re);
      if (m) {
        lineIndex = i;
        indent = m[1];
        existingDecls = parseStyleDirectiveDecls(m[2]);
      }
    }
  });

  const merged = { ...existingDecls, ...patch };
  const serialized = serializeStyleDirectiveDecls(merged);
  const newLine = serialized ? `${indent}style ${nodeId} ${serialized}` : null;

  if (lineIndex !== -1) {
    if (newLine) {
      lines[lineIndex] = newLine;
    } else {
      lines.splice(lineIndex, 1);
    }
    return lines.join('\n');
  }

  if (!newLine) return source || '';
  const withoutTrailingBlank = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
  return [...withoutTrailingBlank, newLine].join('\n');
}
