// Pure helpers for the per-node color picker's state-diagram support.
//
// Verified against the real `mermaid` package (not assumed from memory):
// unlike flowcharts, Mermaid's stateDiagram-v2 rejects a direct
// `style StateId fill:...` line as a parse error. Per-state coloring only
// works through `classDef className fill:...` + `class StateId className`
// — a class definition plus an assignment, two coordinated lines instead
// of flowchart's one. This module manages both together, under a
// deterministic per-state class name (`nodeStyle_<stateId>`), so it reads
// and writes like a single per-state style even though it's backed by two
// source lines.
import { detectDiagramKind } from './diagram-kind.js';

const RESERVED_WORDS = new Set([
  'stateDiagram',
  'stateDiagram-v2',
  'state',
  'note',
  'end',
  'classDef',
  'class',
  'direction',
  'hide',
  'empty',
  'as',
  'of',
  'TB',
  'BT',
  'RL',
  'LR',
]);

const STATE_STYLE_PROPS = ['fill', 'stroke', 'stroke-width', 'color'];

export function isStateDiagramSource(source) {
  return detectDiagramKind(source) === 'state';
}

/**
 * Best-effort extraction of state ids: transition endpoints (`A --> B`,
 * excluding the `[*]` start/end pseudostate), `state StateName` / `state
 * "desc" as StateName` / `state StateName {` declarations, and `StateName :
 * description` inline descriptions. Regex-based, not a real parser — misses
 * a state that's *only* ever referenced via a `class`/`note` line and never
 * declared or used in a transition, same "best-effort" caveat as
 * node-style.js's flowchart parser.
 */
export function parseStateIds(source) {
  const text = source || '';
  const ids = new Set();

  text.split('\n').forEach((line) => {
    const trimmed = line.trim();

    const transitionMatch = trimmed.match(/^(\[\*\]|[A-Za-z_]\w*)\s*-->\s*(\[\*\]|[A-Za-z_]\w*)/);
    if (transitionMatch) {
      [transitionMatch[1], transitionMatch[2]].forEach((id) => {
        if (id !== '[*]') ids.add(id);
      });
      return;
    }

    const compositeMatch = trimmed.match(/^state\s+([A-Za-z_]\w*)\s*\{/);
    if (compositeMatch) {
      ids.add(compositeMatch[1]);
      return;
    }

    const aliasMatch = trimmed.match(/^state\s+"[^"]*"\s+as\s+([A-Za-z_]\w*)/);
    if (aliasMatch) {
      ids.add(aliasMatch[1]);
      return;
    }

    const bareMatch = trimmed.match(/^state\s+([A-Za-z_]\w*)\s*$/);
    if (bareMatch) {
      ids.add(bareMatch[1]);
      return;
    }

    // `state ChoiceId <<choice>>` (also `<<fork>>`/`<<join>>`) — a
    // pseudostate-type declaration, distinct from the bare/composite/alias
    // forms above since it has trailing `<<...>>` content after the id.
    // Needed so diagram-palette.js's "Choice" entry can find previously
    // inserted choice ids via nextAvailableId — missing this meant a second
    // click could reuse the same id and silently produce two conflicting
    // declarations, the same class of bug node-style.js's parseFlowchartNodeIds
    // once had for `@{...}` declarations.
    const pseudoStateMatch = trimmed.match(/^state\s+([A-Za-z_]\w*)\s+<<\w+>>\s*$/);
    if (pseudoStateMatch) {
      ids.add(pseudoStateMatch[1]);
      return;
    }

    const descMatch = trimmed.match(/^([A-Za-z_]\w*)\s*:\s*.+$/);
    if (descMatch) {
      ids.add(descMatch[1]);
    }
  });

  RESERVED_WORDS.forEach((word) => ids.delete(word));
  return Array.from(ids).sort();
}

function styleClassName(stateId) {
  return `nodeStyle_${stateId}`;
}

// Same comma-separated `prop:value,prop:value` directive syntax as
// node-style.js's flowchart directives — duplicated here rather than
// shared, since the two modules' upsert logic (one line vs. two
// coordinated lines) differs enough that sharing would mean threading
// more through a common module than it'd save.
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
  return STATE_STYLE_PROPS.filter((prop) => decls[prop])
    .map((prop) => `${prop}:${decls[prop]}`)
    .join(',');
}

/** Map of stateId -> { fill?, stroke?, color? }, read from this picker's own `classDef nodeStyle_<id> ...` lines (any other hand-written classDefs are ignored). */
export function parseStateStyles(source) {
  const result = {};
  (source || '').split('\n').forEach((line) => {
    const m = line.match(/^\s*classDef\s+(\S+)\s+(.*)$/);
    if (!m) return;
    const stateMatch = m[1].match(/^nodeStyle_([A-Za-z_]\w*)$/);
    if (!stateMatch) return;
    result[stateMatch[1]] = parseStyleDirectiveDecls(m[2]);
  });
  return result;
}

/**
 * Merges `patch` into stateId's dedicated `classDef nodeStyle_<id> ...` +
 * `class <id> nodeStyle_<id>` pair, creating both if neither exists, or
 * removing both once the merge leaves no channel set. Any *other*
 * hand-written classDef/class lines for this state are left untouched —
 * Mermaid applies all matching classes, so this only ever adds or removes
 * its own dedicated one.
 */
export function upsertStateStyle(source, stateId, patch) {
  const className = styleClassName(stateId);
  let lines = (source || '').split('\n');

  const classDefRe = new RegExp(`^(\\s*)classDef\\s+${className}\\s+(.*)$`);
  const classAssignRe = new RegExp(`^\\s*class\\s+${stateId}\\s+${className}\\s*$`);

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
    lines.push(`class ${stateId} ${className}`);
  }

  return lines.join('\n');
}
