// Shared "what diagram type is this source" detection. Extracted from
// node-style.js/state-style.js/er-style.js, which each carried an
// identical firstContentLine-plus-regex check duplicated three times —
// diagram-palette.js needs the same detection for several more diagram
// types (sequence/class/gantt/kanban/c4/pie), so this pulls it into one
// place rather than adding a fourth (and fifth, and sixth...)
// independently-maintained copy.
//
// Regex-based, not a real Mermaid parser: checks only the first non-`%%`
// content line's leading keyword. Same "best-effort" caveat as every other
// parser in this app family — an unusual/malformed first line just means a
// diagram is treated as unrecognized, not that anything breaks.

const KIND_PATTERNS = [
  ['flowchart', /^(flowchart|graph)\b/],
  ['state', /^stateDiagram(-v2)?\b/],
  ['er', /^erDiagram\b/],
  ['sequence', /^sequenceDiagram\b/],
  ['class', /^classDiagram\b/],
  ['gantt', /^gantt\b/],
  ['kanban', /^kanban\b/],
  ['c4', /^C4(Context|Container|Component|Dynamic|Deployment)\b/],
  ['pie', /^pie\b/],
];

export function firstContentLine(source) {
  return (source || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('%%'));
}

/** One of the KIND_PATTERNS keys above, or null if the first content line doesn't match any known diagram type. */
export function detectDiagramKind(source) {
  const line = firstContentLine(source);
  if (!line) return null;
  const match = KIND_PATTERNS.find(([, re]) => re.test(line));
  return match ? match[0] : null;
}
