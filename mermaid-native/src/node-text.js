// Dispatches "get/set this node's displayed text" per diagram kind, for the
// double-click-to-edit-text gesture (DiagramCanvas.jsx / App.jsx). Mirrors
// node-style-kind.js's per-kind dispatch shape, but for a genuinely
// different concept: a node's *label* — or, for ER, its *id* — rather than
// its color styling. Every backend shares the same `(source, nodeId, text?)`
// signature: `getText(source, nodeId)` reads the current value to show in
// the edit field, `setText(source, nodeId, text)` writes it back.
//
// Verified against the real mermaid parser per kind before writing any of
// this (same convention as every other diagram-syntax decision in this
// app):
// - Flowchart: the existing bracket/`@{...}` label machinery in
//   node-label.js, reused here for a full-text replace rather than just
//   the icon picker's prefix merge.
// - State: `state "description" as Id` or a bare `Id : description` line
//   (state-style.js) — both parse and both render the description in
//   place of the bare id.
// - Class: `class Id["Display Name"]` — a bracket-label shorthand that
//   parses as its own standalone line, distinct from (and freely
//   combinable with) a `{ members }` attribute block for the same id.
//   Editing the member/method list is a different, much larger feature,
//   deliberately out of scope here — only this bracket display-name
//   counts as "the label." Confirmed the bracket form requires double
//   quotes specifically — single-quoted and unquoted multi-word variants
//   are both parse errors.
// - Sequence: `participant Id as Display Name` / `actor Id as Display
//   Name` — confirmed an unquoted, multi-word display name parses fine.
// - ER has no separate label mechanism at all — the only text an entity
//   ever displays is its own id (verified: no bracket/alias/description
//   form exists for erDiagram). "Adding text" there necessarily means
//   renaming the id itself, which cascades to every relationship line
//   referencing it — see er-style.js's renameERId, kept as its own
//   dedicated function rather than force-fit into this module's
//   separate-label shape, since it's a structurally different (and
//   riskier) operation. `isRename: true` is how callers (App.jsx) know to
//   treat a committed edit as "the node's own id changed" rather than "a
//   label changed" — e.g. re-pointing whatever `selectedNode`/popover
//   anchor state was tracking the old id.
import { detectDiagramKind } from './diagram-kind.js';
import { parseFlowchartNodeIds } from './node-style.js';
import { getNodeLabelText, setNodeLabelText } from './node-label.js';
import { parseStateIds, getStateLabelText, setStateLabelText } from './state-style.js';
import { parseERIds, renameERId } from './er-style.js';
import { parseClassIds, parseSequenceMessages } from './diagram-connect.js';

function classLabelRegex(classId) {
  return new RegExp(`^(\\s*)class\\s+${classId}\\s*\\[\\s*"([^"]*)"\\s*\\]\\s*$`);
}

/** The class's current bracket display-label (`class Id["..."]`), or '' if it has none — meaning it only ever displays its own bare id. */
export function getClassLabelText(source, classId) {
  const re = classLabelRegex(classId);
  for (const line of (source || '').split('\n')) {
    const m = line.match(re);
    if (m) return m[2];
  }
  return '';
}

/**
 * Sets (or clears) the class's bracket display-label, for the
 * double-click-to-edit gesture. Rewrites an existing bracket-label line in
 * place, or removes it entirely if cleared. Synthesizes a new
 * `class Id["text"]` line if none exists yet — a class's own `{ members }`
 * block (a separate declaration line — see this file's header comment) is
 * never touched. Strips embedded double quotes from `text` (same
 * "always-quotable" tradeoff as er-style.js's ER labels) since the bracket
 * form requires double quotes and doesn't support escaping them.
 */
export function setClassLabelText(source, classId, text) {
  const lines = (source || '').split('\n');
  const re = classLabelRegex(classId);
  const idx = lines.findIndex((line) => re.test(line));
  const escaped = (text || '').replace(/"/g, '');

  if (idx !== -1) {
    if (!text) {
      lines.splice(idx, 1);
      return lines.join('\n');
    }
    const [, indent] = lines[idx].match(re);
    lines[idx] = `${indent}class ${classId}["${escaped}"]`;
    return lines.join('\n');
  }

  if (!text) return source || '';
  const trimmedEnd = lines.length && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
  return [...trimmedEnd, `class ${classId}["${escaped}"]`].join('\n');
}

function participantAliasRegex(participantId) {
  return new RegExp(`^(\\s*)(participant|actor)\\s+${participantId}\\s+as\\s+(.*)$`);
}

function participantBareRegex(participantId) {
  return new RegExp(`^(\\s*)(participant|actor)\\s+${participantId}\\s*$`);
}

/** The participant/actor's current display alias (`... as Display Name`), or '' if it has none — meaning it only ever displays its own bare id. */
export function getParticipantLabelText(source, participantId) {
  const re = participantAliasRegex(participantId);
  for (const line of (source || '').split('\n')) {
    const m = line.match(re);
    if (m) return m[3].trim();
  }
  return '';
}

/**
 * Sets (or clears) a participant/actor's display alias, for the
 * double-click-to-edit gesture. Rewrites an existing alias line in place;
 * upgrades a bare `participant Id`/`actor Id` declaration to the alias
 * form if one exists but has no alias yet; synthesizes a brand-new
 * `participant Id as text` line otherwise (auto-declares, same as this
 * app's other sequence-inserting code — see diagram-palette.js). Clearing
 * an alias reverts the declaration to its bare form rather than writing an
 * empty `as` clause.
 */
export function setParticipantLabelText(source, participantId, text) {
  const lines = (source || '').split('\n');

  const aliasRe = participantAliasRegex(participantId);
  const aliasIdx = lines.findIndex((line) => aliasRe.test(line));
  if (aliasIdx !== -1) {
    const [, indent, keyword] = lines[aliasIdx].match(aliasRe);
    lines[aliasIdx] = text ? `${indent}${keyword} ${participantId} as ${text}` : `${indent}${keyword} ${participantId}`;
    return lines.join('\n');
  }

  const bareRe = participantBareRegex(participantId);
  const bareIdx = lines.findIndex((line) => bareRe.test(line));
  if (bareIdx !== -1) {
    if (!text) return source || '';
    const [, indent, keyword] = lines[bareIdx].match(bareRe);
    lines[bareIdx] = `${indent}${keyword} ${participantId} as ${text}`;
    return lines.join('\n');
  }

  if (!text) return source || '';
  const trimmedEnd = lines.length && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
  return [...trimmedEnd, `participant ${participantId} as ${text}`].join('\n');
}

/**
 * Every participant/actor id currently in play: explicit `participant`/
 * `actor` declarations, plus any id only ever auto-declared by appearing
 * as a message endpoint (confirmed against the real parser — no explicit
 * declaration is required, and an auto-declared participant renders the
 * exact same `data-et="participant"` top box as an explicit one). Needed
 * as this kind's "does this id still exist" guard — diagram-palette.js's
 * own (unexported) participant-id parser only covers explicit
 * declarations, which would otherwise report a false negative for the
 * common case of an undeclared, message-only participant.
 */
export function parseSequenceParticipantIds(source) {
  const ids = new Set();
  (source || '').split('\n').forEach((line) => {
    const m = line.trim().match(/^(?:participant|actor)\s+([A-Za-z_]\w*)/);
    if (m) ids.add(m[1]);
  });
  parseSequenceMessages(source).forEach((msg) => {
    ids.add(msg.fromId);
    ids.add(msg.toId);
  });
  return Array.from(ids);
}

/**
 * Resolves the double-click-to-edit-text backend for whichever diagram
 * type `source` is, or `null` if this diagram type has no node/participant
 * text to edit at all — mirrors node-style-kind.js's resolveNodeStyleKind
 * dispatch shape, including its "return null = nothing to offer"
 * convention. `parseIds` is the same per-kind "does this id still exist"
 * guard every popover in this app uses to detect a source edit that
 * removed the clicked node out from under it.
 */
export function resolveNodeTextKind(source) {
  const kind = detectDiagramKind(source);
  if (kind === 'flowchart') {
    return { kind, isRename: false, parseIds: parseFlowchartNodeIds, getText: getNodeLabelText, setText: setNodeLabelText };
  }
  if (kind === 'state') {
    return { kind, isRename: false, parseIds: parseStateIds, getText: getStateLabelText, setText: setStateLabelText };
  }
  if (kind === 'class') {
    return { kind, isRename: false, parseIds: parseClassIds, getText: getClassLabelText, setText: setClassLabelText };
  }
  if (kind === 'sequence') {
    return {
      kind,
      isRename: false,
      parseIds: parseSequenceParticipantIds,
      getText: getParticipantLabelText,
      setText: setParticipantLabelText,
    };
  }
  if (kind === 'er') {
    return { kind, isRename: true, parseIds: parseERIds, getText: (source_, nodeId) => nodeId, setText: renameERId };
  }
  return null;
}
