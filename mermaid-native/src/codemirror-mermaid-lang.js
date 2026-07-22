import { StreamLanguage, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';

// Not an exhaustive Mermaid grammar — a lightweight token-by-token scanner
// covering what shows up across this app's own templates (flowchart,
// sequence, state, class, ER, gantt, pie, kanban, C4 — see
// diagram-templates.js) plus %%-comments and %%{init:...}%% directives.
// Good enough for "this reads like code, not a blob of text"; not a
// replacement for a real parser. `codemirror-lang-mermaid` (the one
// existing community package) was skipped as a dependency — 3 years
// stale, last published for an earlier CodeMirror 6 API — in favor of
// this small hand-rolled scanner, consistent with this project's general
// preference for a thin hand-rolled piece over an unmaintained dependency.
const KEYWORDS = new Set([
  // Diagram type declarations
  // Not 'stateDiagram-v2' as one entry — the identifier regex below can't
  // consume its own hyphen (see that comment), so only the 'stateDiagram'
  // prefix is ever matched as a single word token anyway.
  'flowchart', 'graph', 'sequenceDiagram', 'classDiagram',
  'stateDiagram', 'erDiagram', 'gantt', 'pie', 'kanban', 'mindmap', 'journey',
  'gitGraph', 'quadrantChart', 'timeline', 'C4Context', 'C4Container',
  'C4Component', 'C4Dynamic', 'C4Deployment', 'requirementDiagram',
  // Structural / block keywords
  'participant', 'actor', 'activate', 'deactivate', 'note', 'over', 'left',
  'right', 'of', 'loop', 'alt', 'else', 'opt', 'par', 'and', 'end', 'rect',
  'critical', 'break', 'class', 'classDef', 'style', 'state', 'subgraph',
  'click', 'title', 'section', 'dateFormat', 'axisFormat', 'excludes',
  'todayMarker', 'direction',
  // Flowchart direction shorthands
  'TD', 'TB', 'BT', 'RL', 'LR',
]);

// Longer/more specific arrow forms first so the shorter prefixes below them
// don't shadow a match.
const ARROW_RE =
  /^(<\|--|--\|>|-\.->|-\.-|={2,3}>?|--x|--\)|<-->|-->>|->>|--->|---|-->|->|::)/;

function mermaidToken(stream) {
  if (stream.match(/^%%\{[\s\S]*?\}%%/)) return 'meta';
  if (stream.match(/^%%.*/)) return 'comment';
  if (stream.match(/^"([^"\\]|\\.)*"?/) || stream.match(/^'([^'\\]|\\.)*'?/)) return 'string';
  if (stream.match(ARROW_RE)) return 'operator';
  if (stream.match(/^[{}[\]()]/)) return 'bracket';
  if (stream.match(/^-?\d+(\.\d+)?/)) return 'number';
  // No hyphen in the continuation set, even though some Mermaid identifiers
  // use one (e.g. the keyword "stateDiagram-v2") — a hyphen-greedy
  // identifier regex would eat the leading "-" of an immediately-following
  // arrow (confirmed: "A->>B" mis-tokenized as "A-" + stray ">>" before this
  // was narrowed). "stateDiagram-v2" still gets its "stateDiagram" prefix
  // highlighted as a keyword; the "-v2" suffix just renders unstyled, an
  // acceptable tradeoff since arrows are far more common/prominent in every
  // diagram than that one specific keyword's suffix.
  const word = stream.match(/^[A-Za-z_][A-Za-z0-9_]*/);
  if (word) return KEYWORDS.has(word[0]) ? 'keyword' : null;
  stream.next();
  return null;
}

export const mermaidLanguage = StreamLanguage.define({ token: mermaidToken });

// Colors picked to hold reasonable contrast against both this app's light
// (--color-input-bg #fff) and dark (#22272b) editor backgrounds — see
// CodeMirrorEditor.jsx's editorTheme() — rather than a separate light/dark
// highlight style to keep in sync by hand.
export const mermaidHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: '#a371f7', fontWeight: '600' },
  { tag: tags.comment, color: 'var(--color-text-subtle)', fontStyle: 'italic' },
  { tag: tags.string, color: '#4ac26b' },
  { tag: tags.operator, color: 'var(--color-primary)' },
  { tag: tags.bracket, color: 'var(--color-text-subtle)' },
  { tag: tags.number, color: '#e0862c' },
  { tag: tags.meta, color: '#a371f7', opacity: '0.75' },
]);
