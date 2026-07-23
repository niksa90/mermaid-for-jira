// Pure helpers for flowchart node labels: reads/writes a leading emoji (the
// per-node icon picker) or the full label text (the double-click-to-edit
// gesture — see node-text.js's dispatcher) on a node's bracket-declared or
// Mermaid v11 unified `@{...}`-declared label.
//
// Flowchart-only for now (mirrors this project's usual "one diagram type
// first, verify, then extend" pattern — see node-style.js/state-style.js/
// er-style.js's own history). State diagrams and ER entities don't have an
// equivalent free-text label — state's own text-editing lives in
// state-style.js instead (a genuinely different mechanism: a separate
// `state "desc" as Id`/`Id : desc` form, not a bracket label), and ER has
// no label mechanism at all (see node-text.js's header comment).
//
// Emoji survive Mermaid's parse/render/DOMPurify pipeline as plain SVG
// text content unmodified — confirmed via a jsdom scratch render against
// the real mermaid package, not assumed.

// Only three of Mermaid's many flowchart node shapes are recognized here —
// the same subset node-style.js's parser already limits itself to.
// Deliberately strict (no `.` wildcard across the whole line): a shape
// using doubled brackets (`((Circle))`, `{{Hexagon}}`, `[[Subroutine]]`,
// `([Stadium])`, ...) won't match because the disallowed bracket character
// appears inside the captured text, so it's silently left alone rather
// than corrupted — same "best-effort, unusual syntax silently unsupported"
// convention as every other parser in this app.
const BRACKET_SHAPES = [
  { open: '[', close: ']', innerCharClass: '[^\\[\\]]' },
  { open: '(', close: ')', innerCharClass: '[^()]' },
  { open: '{', close: '}', innerCharClass: '[^{}]' },
];

// A small curated set, not a full emoji picker — deliberately narrow so
// getNodeIcon can recognize (and toggle off) exactly the icons this picker
// itself inserts, without having to detect arbitrary Unicode emoji
// sequences (multi-codepoint ZWJ sequences, skin-tone modifiers, flags,
// ...) which a hand-typed label could otherwise contain.
export const QUICK_ICONS = ['🚀', '⚙️', '✅', '⚠️', '🔒', '💡', '📦', '🐛'];

// Not anchored to the whole line — `A[Start] --> B[End]` (this app's own
// default new-diagram template) puts a node's shape+label and its edges on
// one line, so the label span has to be found and replaced in place within
// whatever else is on that line, not required to BE the entire line. The
// leading `(^|[^A-Za-z0-9_])` boundary stops nodeId from matching inside a
// longer identifier (e.g. looking for "A" must not match the "A" in "AB").
function findLabelLine(lines, nodeId) {
  for (let i = 0; i < lines.length; i += 1) {
    for (const shape of BRACKET_SHAPES) {
      const re = new RegExp(
        `(^|[^A-Za-z0-9_])${nodeId}\\s*\\${shape.open}(${shape.innerCharClass}*)\\${shape.close}`
      );
      const m = lines[i].match(re);
      if (m) return { index: i, shape, text: m[2], boundary: m[1], matchStart: m.index, fullMatch: m[0] };
    }
  }
  return null;
}

function hasAnyShapeDeclaration(lines, nodeId) {
  const re = new RegExp(`(^|[^A-Za-z0-9_])${nodeId}\\s*[[({]`);
  return lines.some((line) => re.test(line));
}

// Mermaid v11's unified node syntax, `NodeId@{ shape: rect, label: "..." }`
// (see diagram-palette.js) — a genuinely different declaration shape from
// BRACKET_SHAPES above, not just another bracket pair, so it needs its own
// matcher rather than being folded into findLabelLine's loop. Finds the
// `label: "..."` property specifically (not just any quoted string in the
// `@{...}` body) since other properties can also hold quoted strings.
function findAtShapeLabelLine(lines, nodeId) {
  const re = new RegExp(`(^|[^A-Za-z0-9_])${nodeId}\\s*@\\{([^}]*)\\}`);
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(re);
    if (m) {
      const labelMatch = m[2].match(/label\s*:\s*"([^"]*)"/);
      return {
        index: i,
        text: labelMatch ? labelMatch[1] : '',
        boundary: m[1],
        propsText: m[2],
        matchStart: m.index,
        fullMatch: m[0],
      };
    }
  }
  return null;
}

// Rewrites just the `label: "..."` property within an `@{...}` body,
// leaving `shape: ...` (and anything else) untouched — adds a label
// property if the node's `@{...}` didn't have one yet, rather than
// assuming every such declaration necessarily has one.
function replaceAtShapeLabel(propsText, newLabelText) {
  const escaped = newLabelText.replace(/"/g, '\\"');
  if (/label\s*:\s*"[^"]*"/.test(propsText)) {
    return propsText.replace(/label\s*:\s*"[^"]*"/, `label: "${escaped}"`);
  }
  const trimmed = propsText.trim();
  return trimmed ? `${propsText}, label: "${escaped}"` : ` label: "${escaped}" `;
}

function stripKnownIconPrefix(text) {
  for (const icon of QUICK_ICONS) {
    if (text === icon) return '';
    if (text.startsWith(`${icon} `)) return text.slice(icon.length + 1);
  }
  return text;
}

/** The currently-applied quick-pick icon on a node's label, or '' if none (either no icon, or a label icon this picker doesn't recognize). */
export function getNodeIcon(source, nodeId) {
  const lines = (source || '').split('\n');
  const found = findLabelLine(lines, nodeId) || findAtShapeLabelLine(lines, nodeId);
  if (!found) return '';
  const { text } = found;
  return QUICK_ICONS.find((icon) => text === icon || text.startsWith(`${icon} `)) || '';
}

/**
 * Sets (or clears, if `icon` is falsy) the leading icon on nodeId's label.
 * If the node has a recognized single-bracket shape declaration, or a
 * Mermaid v11 unified `@{ shape: ..., label: "..." }` declaration (see
 * diagram-palette.js), rewrites its label in place. If the node has no
 * shape declaration at all (an edge-only node, e.g. only ever appears as
 * `A --> B`), synthesizes a new `NodeId[icon]` line rather than leaving the
 * icon with nowhere to go. If the node has an unrecognized (doubled-bracket)
 * shape, this is a no-op — adding a second, conflicting shape declaration
 * for the same id would be worse than silently not supporting that shape
 * yet. This last case is exactly what used to happen for `@{...}` nodes
 * before this function recognized them: a palette-inserted node's icon pick
 * synthesized a conflicting `NodeId[icon]` line, which silently won over
 * (and discarded) the original shape and label — see this file's git
 * history/PR discussion for the real bug report.
 */
export function setNodeIcon(source, nodeId, icon) {
  const lines = (source || '').split('\n');
  const found = findLabelLine(lines, nodeId);

  if (found) {
    const rest = stripKnownIconPrefix(found.text);
    const newText = icon ? (rest ? `${icon} ${rest}` : icon) : rest;
    const replacement = `${found.boundary}${nodeId}${found.shape.open}${newText}${found.shape.close}`;
    const line = lines[found.index];
    lines[found.index] =
      line.slice(0, found.matchStart) + replacement + line.slice(found.matchStart + found.fullMatch.length);
    return lines.join('\n');
  }

  const atShape = findAtShapeLabelLine(lines, nodeId);
  if (atShape) {
    const rest = stripKnownIconPrefix(atShape.text);
    const newText = icon ? (rest ? `${icon} ${rest}` : icon) : rest;
    const newProps = replaceAtShapeLabel(atShape.propsText, newText);
    const replacement = `${atShape.boundary}${nodeId}@{${newProps}}`;
    const line = lines[atShape.index];
    lines[atShape.index] =
      line.slice(0, atShape.matchStart) + replacement + line.slice(atShape.matchStart + atShape.fullMatch.length);
    return lines.join('\n');
  }

  if (!icon) return source || '';
  if (hasAnyShapeDeclaration(lines, nodeId)) return source || '';

  const withoutTrailingBlank = lines.length && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
  return [...withoutTrailingBlank, `${nodeId}[${icon}]`].join('\n');
}

/** The node's current full label text (bracket or `@{...}` label), or '' if it has no shape/label declaration at all. */
export function getNodeLabelText(source, nodeId) {
  const lines = (source || '').split('\n');
  const found = findLabelLine(lines, nodeId) || findAtShapeLabelLine(lines, nodeId);
  return found ? found.text : '';
}

/**
 * Sets the node's full label text, for the double-click-to-edit gesture.
 * Same three-tier fallback as setNodeIcon (bracket shape, then `@{...}`
 * shape, then — for a node with no shape declaration at all — synthesize a
 * new `NodeId[text]` line; a node with an unrecognized doubled-bracket
 * shape is a no-op). Unlike setNodeIcon, this fully replaces the existing
 * text (including any icon prefix) rather than merging with it — retyping
 * the whole label is a deliberate full replace; re-adding an icon
 * afterward is one click away via the icon picker.
 */
export function setNodeLabelText(source, nodeId, text) {
  const lines = (source || '').split('\n');
  const found = findLabelLine(lines, nodeId);
  if (found) {
    const replacement = `${found.boundary}${nodeId}${found.shape.open}${text}${found.shape.close}`;
    const line = lines[found.index];
    lines[found.index] =
      line.slice(0, found.matchStart) + replacement + line.slice(found.matchStart + found.fullMatch.length);
    return lines.join('\n');
  }

  const atShape = findAtShapeLabelLine(lines, nodeId);
  if (atShape) {
    const newProps = replaceAtShapeLabel(atShape.propsText, text);
    const replacement = `${atShape.boundary}${nodeId}@{${newProps}}`;
    const line = lines[atShape.index];
    lines[atShape.index] =
      line.slice(0, atShape.matchStart) + replacement + line.slice(atShape.matchStart + atShape.fullMatch.length);
    return lines.join('\n');
  }

  if (!text) return source || '';
  if (hasAnyShapeDeclaration(lines, nodeId)) return source || '';

  const withoutTrailingBlank = lines.length && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
  return [...withoutTrailingBlank, `${nodeId}[${text}]`].join('\n');
}
