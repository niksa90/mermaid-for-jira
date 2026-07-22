// Pure helpers for the per-node icon picker: reads/writes a leading emoji
// on a flowchart node's bracket-declared label text (e.g. `A[🚀 Deploy]`).
//
// Flowchart-only for now (mirrors this project's usual "one diagram type
// first, verify, then extend" pattern — see node-style.js/state-style.js/
// er-style.js's own history). State diagrams and ER entities don't have an
// equivalent free-text label to prepend an icon to without bigger,
// diagram-type-specific rewrites (a state's displayed text is either its
// bare id or a separate `state "desc" as Id`/`Id : desc` form; an ER
// entity's displayed text is just its id, with no separate label syntax at
// all) — deferred rather than guessed at.
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

function stripKnownIconPrefix(text) {
  for (const icon of QUICK_ICONS) {
    if (text === icon) return '';
    if (text.startsWith(`${icon} `)) return text.slice(icon.length + 1);
  }
  return text;
}

/** The currently-applied quick-pick icon on a node's label, or '' if none (either no icon, or a label icon this picker doesn't recognize). */
export function getNodeIcon(source, nodeId) {
  const found = findLabelLine((source || '').split('\n'), nodeId);
  if (!found) return '';
  const { text } = found;
  return QUICK_ICONS.find((icon) => text === icon || text.startsWith(`${icon} `)) || '';
}

/**
 * Sets (or clears, if `icon` is falsy) the leading icon on nodeId's label.
 * If the node has a recognized single-bracket shape declaration, rewrites
 * its label in place. If the node has no shape declaration at all (an
 * edge-only node, e.g. only ever appears as `A --> B`), synthesizes a new
 * `NodeId[icon]` line rather than leaving the icon with nowhere to go. If
 * the node has an unrecognized (doubled-bracket) shape, this is a no-op —
 * adding a second, conflicting shape declaration for the same id would be
 * worse than silently not supporting that shape yet.
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

  if (!icon) return source || '';
  if (hasAnyShapeDeclaration(lines, nodeId)) return source || '';

  const withoutTrailingBlank = lines.length && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
  return [...withoutTrailingBlank, `${nodeId}[${icon}]`].join('\n');
}
