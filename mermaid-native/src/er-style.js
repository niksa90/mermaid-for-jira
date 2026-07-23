// Pure helpers for the per-node color picker's ER-diagram support.
//
// Verified against the real `mermaid` package (not assumed from memory, via
// a jsdom scratch render): unlike state diagrams, an ER entity's per-element
// style comes out as a literal `style="fill:#... !important"` attribute
// directly on the entity's `<rect>` — the same rendered-output code path as
// flowchart's `style NodeId ...` directive, already handled by
// mermaid-renderer.js's parseInlineStyleAttr with zero changes needed here.
// But ER's *source* syntax for reaching that output is `classDef`+`class`,
// like state diagrams, not flowchart's single `style` line — so this module
// mirrors state-style.js's two-line mechanism, not node-style.js's one-line
// one, even though the two diagram types don't share source syntax either.

import { detectDiagramKind } from './diagram-kind.js';

const RESERVED_WORDS = new Set(['erDiagram', 'classDef', 'class']);

const ER_STYLE_PROPS = ['fill', 'stroke', 'stroke-width', 'color'];

export function isERDiagramSource(source) {
  return detectDiagramKind(source) === 'er';
}

/**
 * Best-effort extraction of entity ids: both endpoints of a relationship
 * line (`CUSTOMER ||--o{ ORDER : places`, identified by the crow's-foot
 * notation token between the two identifiers rather than a fixed set of
 * exact tokens, so identifying/non-identifying and any cardinality combo
 * all match) and standalone `EntityName {` attribute-block declarations.
 * Regex-based, not a real parser — same "best-effort" caveat as
 * node-style.js/state-style.js's parsers.
 */
export function parseERIds(source) {
  const text = source || '';
  const ids = new Set();

  text.split('\n').forEach((line) => {
    const trimmed = line.trim();

    const relMatch = trimmed.match(/^([A-Za-z_]\w*)\s+[|o{}.-]+\s+([A-Za-z_]\w*)\s*(:.*)?$/);
    if (relMatch) {
      ids.add(relMatch[1]);
      ids.add(relMatch[2]);
      return;
    }

    const blockMatch = trimmed.match(/^([A-Za-z_]\w*)\s*\{\s*$/);
    if (blockMatch) {
      ids.add(blockMatch[1]);
    }
  });

  RESERVED_WORDS.forEach((word) => ids.delete(word));
  return Array.from(ids).sort();
}

function styleClassName(entityId) {
  return `nodeStyle_${entityId}`;
}

// Same comma-separated `prop:value,prop:value` directive syntax as
// node-style.js/state-style.js's directives — duplicated rather than
// shared, matching this codebase's existing convention of keeping each
// diagram-type's style module self-contained (see state-style.js's own
// note on this).
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
  return ER_STYLE_PROPS.filter((prop) => decls[prop])
    .map((prop) => `${prop}:${decls[prop]}`)
    .join(',');
}

/** Map of entityId -> { fill?, stroke?, color? }, read from this picker's own `classDef nodeStyle_<id> ...` lines (any other hand-written classDefs are ignored). */
export function parseERStyles(source) {
  const result = {};
  (source || '').split('\n').forEach((line) => {
    const m = line.match(/^\s*classDef\s+(\S+)\s+(.*)$/);
    if (!m) return;
    const entityMatch = m[1].match(/^nodeStyle_([A-Za-z_]\w*)$/);
    if (!entityMatch) return;
    result[entityMatch[1]] = parseStyleDirectiveDecls(m[2]);
  });
  return result;
}

/**
 * Merges `patch` into entityId's dedicated `classDef nodeStyle_<id> ...` +
 * `class <id> nodeStyle_<id>` pair, creating both if neither exists, or
 * removing both once the merge leaves no channel set. Any *other*
 * hand-written classDef/class lines for this entity are left untouched.
 */
export function upsertERStyle(source, entityId, patch) {
  const className = styleClassName(entityId);
  let lines = (source || '').split('\n');

  const classDefRe = new RegExp(`^(\\s*)classDef\\s+${className}\\s+(.*)$`);
  const classAssignRe = new RegExp(`^\\s*class\\s+${entityId}\\s+${className}\\s*$`);

  let classDefIndex = -1;
  let indent = '';
  let existingDecls = {};
  lines.forEach((line, i) => {
    if (classDefIndex === -1) {
      const m = line.match(classDefRe);
      if (m) {
        classDefIndex = i;
        indent = m[1];
        existingDecls = parseStyleDirectiveDecls(m[2]);
      }
    }
  });
  const classAssignIndex = lines.findIndex((line) => classAssignRe.test(line));

  const merged = { ...existingDecls, ...patch };
  const serialized = serializeStyleDirectiveDecls(merged);

  if (!serialized) {
    [classAssignIndex, classDefIndex]
      .filter((i) => i !== -1)
      .sort((a, b) => b - a)
      .forEach((i) => lines.splice(i, 1));
    return lines.join('\n');
  }

  const newClassDefLine = `${indent}classDef ${className} ${serialized}`;
  if (classDefIndex !== -1) {
    lines[classDefIndex] = newClassDefLine;
  } else {
    const trimmedEnd = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
    lines = [...trimmedEnd, newClassDefLine];
  }

  if (!lines.some((line) => classAssignRe.test(line))) {
    lines.push(`class ${entityId} ${className}`);
  }

  return lines.join('\n');
}

const REL_LINE_RE = /^(\s*)([A-Za-z_]\w*)(\s+[|o{}.-]+\s+)([A-Za-z_]\w*)(\s*(?::.*)?)$/;
const BLOCK_LINE_RE = /^(\s*)([A-Za-z_]\w*)(\s*\{\s*)$/;

/**
 * Renames an ER entity id everywhere it's structurally used: its own
 * attribute-block header line (`OldId {`) and either endpoint of any
 * relationship line — deliberately NOT a blanket find-and-replace across
 * the whole source, which would also corrupt any relationship *label* that
 * happens to contain the old id as a substring (e.g. renaming `A` while a
 * label reads `: "A special note"`). Both line shapes are matched the same
 * way parseERIds recognizes them, and only the id portion is ever rewritten
 * — the label/rest of a relationship line, and any attribute lines inside
 * an entity's block, are left untouched.
 *
 * This is a fundamentally different (and riskier) operation than the
 * label get/set functions node-text.js's other per-kind backends use — ER
 * has no separate label at all, so "adding text" to an entity necessarily
 * means renaming its id, cascading everywhere that id is referenced. A
 * no-op if `oldId` doesn't exist, or if `newId` already belongs to a
 * *different* existing entity (silently merging two entities into one
 * would be worse than refusing the rename outright — same "don't corrupt
 * what you're not sure about" convention as this app's other parsers).
 * Inherits the same `[A-Za-z_]\w*`-only id restriction as parseERIds
 * (checked against the real parser) — same "best-effort" tradeoff as
 * everywhere else in this app; a hyphenated entity id like `LINE-ITEM`
 * (valid in this app's DOM-side edge-click detection — see
 * svg-node-id.js's extractClickedErEdgeId) can't be renamed via this
 * function, pre-existing and consistent with parseERIds/erEdgeRegex in
 * diagram-connect.js, not a new gap this introduces.
 */
export function renameERId(source, oldId, newId) {
  if (!oldId || !newId || oldId === newId) return source || '';
  const ids = parseERIds(source);
  if (!ids.includes(oldId) || ids.includes(newId)) return source || '';

  const lines = (source || '').split('\n');
  const renamed = lines.map((line) => {
    const block = line.match(BLOCK_LINE_RE);
    if (block && block[2] === oldId) {
      return `${block[1]}${newId}${block[3]}`;
    }
    const rel = line.match(REL_LINE_RE);
    if (rel) {
      const [, indent, from, mid, to, rest] = rel;
      if (from === oldId || to === oldId) {
        return `${indent}${from === oldId ? newId : from}${mid}${to === oldId ? newId : to}${rest}`;
      }
    }
    return line;
  });
  return renamed.join('\n');
}
