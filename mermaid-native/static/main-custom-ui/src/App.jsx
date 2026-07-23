import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invoke, view } from '@forge/bridge';
import Spinner from '../../../src/Spinner';
import SectionMessage from '../../../src/SectionMessage';
import {
  TrashIcon,
  EditIcon,
  CheckIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DatabaseShapeIcon,
  SubroutineShapeIcon,
  TrapezoidShapeIcon,
  LaneShapeIcon,
  ParticipantShapeIcon,
  ActorShapeIcon,
} from '../../../src/icons';
import DiagramView from '../../../src/DiagramView';
import CodeMirrorEditor from '../../../src/CodeMirrorEditor';
import DiagramErrorBoundary from '../../../src/ErrorBoundary';
import { MERMAID_THEMES } from '../../../src/mermaid-renderer';
import { DIAGRAM_TEMPLATES, templateById } from '../../../src/diagram-templates';
import { stableStringify } from '../../../src/stable-json';
import { buildRenderGroups, moveTargetIndex, moveBounds } from '../../../src/diagram-groups';
import { resolveNodeStyleKind } from '../../../src/node-style-kind';
import { resolvePaletteKind } from '../../../src/diagram-palette';
import { isConnectable, connectNodes, deleteEdge } from '../../../src/diagram-connect';
import { getNodeIcon, setNodeIcon, QUICK_ICONS } from '../../../src/node-label';
// Regular weight only — this loads Inter for the Mermaid diagram canvas
// text (see BRAND_FONT_FAMILY in mermaid-renderer.js), not a full app-chrome
// reskin. Browsers synthesize bold from this if a diagram happens to want
// it, which is an acceptable minor degradation rather than doubling the
// font payload for a weight most diagram text never uses.
import '@fontsource/inter/400.css';
import './styles.css';

const SAVE_DEBOUNCE_MS = 600;
// A native <input type="color"> fires onChange continuously while its
// picker is being dragged — tens of times a second, not once on release.
// Every one of those was landing directly on `updateDiagram`, which changes
// `diagram.source`, which DiagramView's render effect (keyed on `source`)
// treats as a brand new diagram to render — so a color drag was triggering
// a full mermaid.render() (layout + DOMPurify sanitize + our own
// inlineSvgStyles DOM parse/serialize) on every single drag tick, with
// nothing throttling how fast those could queue up. On even a modest
// diagram this was enough to pin a CPU core solid and, per a real user
// report, lock up the whole machine — not just the tab. This constant
// throttles how often a color drag actually commits to `diagram.source`
// (and hence triggers a re-render), independent of SAVE_DEBOUNCE_MS above
// which only throttles the network call. See scheduleNodeColorUpdate.
const NODE_COLOR_RENDER_DEBOUNCE_MS = 120;
const UNDO_TIMEOUT_MS = 8000;
// Jira Cloud's documented entity-property value size limit (also enforced
// resolver-side — this is just so the UI can warn before attempting a save
// that's guaranteed to fail): https://developer.atlassian.com/cloud/jira/platform/jira-entity-properties/
const MAX_PROPERTY_BYTES = 32768;
const SIZE_WARNING_RATIO = 0.85;

// Quick-pick swatches for the node style popover's fill/border/text color
// rows — a curated palette (Jira/brand-adjacent hues plus ink/paper
// neutrals) rather than opening straight to the OS color picker for every
// pick, per direct user feedback that raw <input type="color"> swatches
// read as "paint," not a design tool. The native color input is still kept
// alongside these as a "custom" escape hatch for anything outside the set.
const QUICK_SWATCHES = [
  '#0c66e4', // blue
  '#00875a', // green
  '#de350b', // red
  '#6554c0', // purple
  '#ff991f', // orange
  '#172b4d', // ink
  '#ffffff', // paper
  '#dfe1e6', // grey
];

// Discrete border-width presets for the popover's segmented control —
// direct user request for Miro-style thickness buttons instead of a
// continuous slider. Written to diagram.source unitless (e.g. "4", not
// "4px"), matching how applyModernPolish's own default ("3") is written.
const BORDER_WIDTHS = [1, 2, 4, 6];

function payloadSizeBytes(diagramsArr) {
  return new TextEncoder().encode(JSON.stringify({ diagrams: diagramsArr })).length;
}

function newDiagram(theme = 'default', source) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label: '',
    source: source || 'flowchart TD\n  A[Start] --> B[End]',
    theme,
    section: '',
  };
}

function themeLabel(theme) {
  return theme.charAt(0).toUpperCase() + theme.slice(1);
}

// diagram-palette.js entries carry either a plain unicode glyph (□, ◇, ○,
// ...) or one of these marker strings for shapes with no clean single-
// codepoint equivalent (a database cylinder, a subroutine's double
// border, ...) — see icons.jsx's "Hand-drawn shape-preview glyphs" section.
const PALETTE_GLYPH_ICONS = {
  database: DatabaseShapeIcon,
  subroutine: SubroutineShapeIcon,
  trapezoid: TrapezoidShapeIcon,
  lane: LaneShapeIcon,
  participant: ParticipantShapeIcon,
  actor: ActorShapeIcon,
};

function renderPaletteGlyph(glyph) {
  const Icon = PALETTE_GLYPH_ICONS[glyph];
  return Icon ? <Icon label="" size="small" /> : glyph;
}

/**
 * Resolves Jira's own light/dark preference (`theme.colorMode` from
 * `view.getContext()` — 'light' | 'dark' | 'auto', or absent on older
 * bridge versions) down to a plain boolean: 'auto' or an absent field
 * falls back to the OS-level prefers-color-scheme signal. Read once at
 * panel load, not observed live, so a Jira theme change while the panel
 * is already open needs a reload to pick up.
 */
function resolveEffectiveDark(colorMode) {
  if (colorMode === 'dark') return true;
  if (colorMode === 'light') return false;
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

/**
 * Mirrors the resolved dark/light mode onto `<html data-color-mode>` —
 * the single source of truth styles.css's `[data-color-mode='dark']` rule
 * reacts to, rather than also keeping a separate prefers-color-scheme CSS
 * block in sync with the same palette by hand.
 */
function applyColorMode(isDark) {
  document.documentElement.setAttribute('data-color-mode', isDark ? 'dark' : 'light');
}

export default function App() {
  const [status, setStatus] = useState('loading');
  const [issueKey, setIssueKey] = useState(null);
  const [diagrams, setDiagrams] = useState([]);
  // Edit vs. display is view-only state, not diagram content — kept out of
  // the persisted object so toggling it never costs a resolver invocation
  // (a real Jira REST write) or counts against Forge function GB-seconds.
  const [modes, setModes] = useState({});
  // Collapsed-in-display-mode state — like `modes`, purely a view
  // preference, not diagram content, so it's client-only and never costs a
  // resolver invocation.
  const [collapsed, setCollapsed] = useState({});
  // Collapsed named-section state — same story: a view preference over the
  // `section` field, not content in its own right, so it isn't persisted.
  const [sectionCollapsed, setSectionCollapsed] = useState({});
  // In-progress text for a diagram's Section field while it's focused.
  // Grouping (buildRenderGroups) reacts to diagram.section, and each
  // distinct section name gets its own wrapper element keyed by that name
  // — if diagram.section updated on every keystroke, every character typed
  // would move the diagram into a brand-new wrapper (e.g. "A" then "Ar"
  // then "Arc"...), which React can't reconcile as "the same input that
  // moved" since its parent element is now a different one. That unmounts
  // and remounts the input on every keystroke, dropping focus. Keeping the
  // live-typed text here and only committing to diagram.section on blur
  // keeps the input's DOM node stable while typing.
  const [sectionDraft, setSectionDraft] = useState({});
  // Editor/preview split ratio (editor-pane width, as a percent, in 5%
  // steps). A view preference, not diagram content, so it's client-only
  // and shared across every diagram card's split rather than persisted.
  // Applied via a `data-split` attribute + discrete CSS rules
  // (styles.css), not an inline `style` prop — Forge Custom UI's CSP
  // blocks inline style attributes/tags entirely (see DiagramCanvas.jsx's
  // viewBox-based pan/zoom for the same constraint), so a continuous
  // inline flex-basis isn't an option here.
  const [splitPercent, setSplitPercent] = useState(50);
  // Which template the "Add a diagram" picker currently has selected — a
  // transient UI choice, not diagram content, so it's client-only. Resets
  // to the blank-flowchart default after each add rather than persisting
  // the last pick, so a forgotten selection can't surprise a later add.
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  // The click-on-the-bubble style popover: which diagram/node it's anchored
  // to and where, or null when closed. Only one can be open at a time
  // (global, not per-diagram, unlike modes/collapsed above) — `rect` is a
  // plain snapshot of the clicked node's getBoundingClientRect() taken once
  // at click time, not re-measured live on pan/zoom/scroll (see the
  // click-to-style-plan project memory: re-tracking continuously was judged
  // a rabbit hole with little payoff, so the popover just closes on the
  // next outside click/Escape instead of following the node). This is now
  // the *only* way to reach per-node styling — the older docked
  // dropdown+swatches toolbar was removed per direct user feedback once
  // this shipped, rather than kept as a parallel entry point.
  const [nodePopover, setNodePopover] = useState(null);
  const nodePopoverRef = useRef(null);
  // The popover's actual `top` (position: fixed, viewport px), computed and
  // clamped in the layout effect below rather than derived inline from
  // nodePopover.rect. Fixes a real bug: this used to always be
  // rect.bottom + 8, which for a bottom-row node (single diagram on the
  // panel, tall canvas) can fall below window.innerHeight — the Forge
  // iframe's own viewport, which this app can't scroll past — clipping the
  // color/border controls entirely with no way to reach them.
  //
  // A first fix just flipped to anchoring above the node instead (rect.top
  // - popoverHeight - 8) whenever below didn't fit. That introduced a new
  // failure: for a node positioned high enough that *neither* side has
  // popoverHeight + 8 of room (a short canvas, or a popover taller than
  // either gap — flowchart's popover is taller than state/ER's, since it
  // has an extra icon row), flipping unconditionally to "above" could push
  // the popover's own top edge above y=0, clipping it at the *top* instead
  // — trading one clipped edge for the other rather than actually fixing
  // it. Storing a single already-clamped `top` number (not an
  // above/below enum) fixes this properly: prefer below, fall back to
  // above, and if neither fits, clamp into [8, window.innerHeight -
  // popoverHeight - 8] so the popover is guaranteed to stay fully
  // on-screen rather than committing to whichever side "sounds" better.
  const [popoverTop, setPopoverTop] = useState(0);
  // Whether the panel is effectively rendering in dark mode (see
  // resolveEffectiveDark) — used only to pick a new diagram's starting
  // Mermaid theme (see addDiagram); never re-applied to existing diagrams.
  const [effectiveDark, setEffectiveDark] = useState(false);
  // idle | pending | saving | saved | error | too-large
  const [saveState, setSaveState] = useState('idle');
  const [errorMessage, setErrorMessage] = useState(null);
  // Set when a save was rejected because someone else changed this issue's
  // diagrams since we last read them; holds the server's current value so
  // the user can choose how to resolve it (see resolveConflict*).
  const [conflict, setConflict] = useState(null);
  // Diagram id whose remove button is showing an inline "are you sure?"
  // instead of removing immediately on click.
  const [pendingRemoveId, setPendingRemoveId] = useState(null);
  // Per-diagram source line a Mermaid parse error currently points at (or
  // undefined/null once it clears) — keyed by diagram id since several
  // diagram cards can be in edit mode with independent errors at once.
  // Populated by DiagramView's onError (preview pane) and consumed by
  // CodeMirrorEditor's errorLine prop (editor pane), which are siblings
  // under the same diagram card, not parent/child — hence lifting this up
  // to App.jsx rather than passing it directly between them.
  const [parseErrorLines, setParseErrorLines] = useState({});
  // Most recently removed diagram, kept around briefly so the removal can
  // be undone: { diagram, index } — index is where it lived so undo puts it
  // back in the same place rather than at the end of the list.
  const [undoState, setUndoState] = useState(null);
  // Same pattern as undoState above, but for arrow deletion (DiagramCanvas's
  // click-to-delete-edge) — kept as its own independent state/timeout
  // rather than generalizing undoState to hold either kind, since the two
  // actions (remove a whole diagram vs. delete one edge within it) don't
  // share enough shape to be worth threading through one union type yet:
  // { diagramId, prevSource }.
  const [edgeUndoState, setEdgeUndoState] = useState(null);

  const issueKeyRef = useRef(null);
  const saveTimeoutRef = useRef(null);
  const undoTimeoutRef = useRef(null);
  const edgeUndoTimeoutRef = useRef(null);
  const latestDiagramsRef = useRef([]);
  // What we believe the server currently holds — used for optimistic
  // concurrency (see resolvers/index.js). Updated on load and after every
  // successful save; never derived from our own locally-edited diagrams.
  const baseSnapshotRef = useRef(null);
  // Serializes flushSave calls. Without this, e.g. a textarea's onBlur
  // firing flushSave while the debounced autosave from the same edit is
  // still in flight sends two setFieldValue calls with the same
  // baseSnapshot; the first's write moves the server's real value out from
  // under the second, which the resolver (correctly, given only what it can
  // see) then reports as a conflict — surfacing as "someone else changed
  // these diagrams" even though it was this app's own overlapping saves. A
  // second call arriving while one is in flight is coalesced into a single
  // rerun after the first settles, so it picks up the just-updated
  // baseSnapshot instead of racing against it.
  const saveInFlightRef = useRef(null);
  const pendingRerunRef = useRef(null);
  // See NODE_COLOR_RENDER_DEBOUNCE_MS above.
  const nodeColorTimeoutRef = useRef(null);
  const pendingNodeColorApplyRef = useRef(null);

  // Throttles how often a color drag actually commits to `diagram.source`
  // (each call supersedes the previous one, like the save debounce above —
  // only the last color value in a burst of drag ticks ends up applied).
  function scheduleNodeColorUpdate(applyFn) {
    if (nodeColorTimeoutRef.current) clearTimeout(nodeColorTimeoutRef.current);
    pendingNodeColorApplyRef.current = applyFn;
    nodeColorTimeoutRef.current = setTimeout(() => {
      nodeColorTimeoutRef.current = null;
      const fn = pendingNodeColorApplyRef.current;
      pendingNodeColorApplyRef.current = null;
      fn();
    }, NODE_COLOR_RENDER_DEBOUNCE_MS);
  }

  // Called on blur so the final dragged-to color is applied (and reflected
  // in latestDiagramsRef) before flushSave reads it — otherwise a blur that
  // lands inside the debounce window would save the color from before the
  // final drag position.
  function flushNodeColorUpdate() {
    if (nodeColorTimeoutRef.current) {
      clearTimeout(nodeColorTimeoutRef.current);
      nodeColorTimeoutRef.current = null;
    }
    if (pendingNodeColorApplyRef.current) {
      const fn = pendingNodeColorApplyRef.current;
      pendingNodeColorApplyRef.current = null;
      fn();
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const context = await view.getContext();
        const dark = resolveEffectiveDark(context.theme?.colorMode);
        applyColorMode(dark);
        setEffectiveDark(dark);
        const key = context.extension.issue.key;
        const data = await invoke('getFieldValue', { issueKey: key });
        if (!cancelled) {
          issueKeyRef.current = key;
          setIssueKey(key);
          baseSnapshotRef.current = data.snapshot;
          const loaded = (data.diagrams || []).map((d) => ({ theme: 'default', section: '', ...d }));
          setDiagrams(loaded);
          latestDiagramsRef.current = loaded;
          setModes(Object.fromEntries(loaded.map((d) => [d.id, 'display'])));
          setStatus('ready');
        }
      } catch (err) {
        if (!cancelled) {
          setErrorMessage(err.message || String(err));
          setStatus('error');
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Measures the popover's actual rendered height (varies by diagram kind —
  // see popoverPlacement above) and flips it above the clicked node whenever
  // it wouldn't fit below within the iframe's own viewport. useLayoutEffect,
  // not useEffect: it needs to land before the browser paints, or the
  // popover would visibly flash at the clipped position first.
  useLayoutEffect(() => {
    if (!nodePopover || !nodePopoverRef.current) return;
    const { rect } = nodePopover;
    const margin = 8;
    const popoverHeight = nodePopoverRef.current.getBoundingClientRect().height;
    const belowTop = rect.bottom + margin;
    const aboveTop = rect.top - margin - popoverHeight;
    let top;
    if (belowTop + popoverHeight <= window.innerHeight - margin) {
      top = belowTop; // preferred: matches the original always-below behavior
    } else if (aboveTop >= margin) {
      top = aboveTop; // below doesn't fit; above does
    } else {
      // Neither side has enough room (short canvas / a popover taller than
      // either gap) — clamp fully into the viewport instead of picking a
      // side that would still clip one edge or the other.
      top = Math.min(Math.max(margin, belowTop), Math.max(margin, window.innerHeight - popoverHeight - margin));
    }
    setPopoverTop(top);
  }, [nodePopover]);

  // Closes the click-to-style popover on Escape or on any pointerdown
  // outside it — including the pointerdown that starts panning the canvas
  // underneath it, since that's also outside the popover's own DOM node.
  // Capture phase so this runs before DiagramCanvas's own pointerdown
  // handler, and before a click on a *different* node reopens the popover
  // there via onNodeClick.
  useEffect(() => {
    if (!nodePopover) return undefined;
    function onDocPointerDown(e) {
      if (nodePopoverRef.current && !nodePopoverRef.current.contains(e.target)) {
        setNodePopover(null);
      }
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') setNodePopover(null);
    }
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [nodePopover]);

  // Flush any pending debounced save if the panel closes mid-edit.
  useEffect(
    () => () => {
      flushNodeColorUpdate();
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        flushSave();
      }
      if (undoTimeoutRef.current) {
        clearTimeout(undoTimeoutRef.current);
      }
      if (edgeUndoTimeoutRef.current) {
        clearTimeout(edgeUndoTimeoutRef.current);
      }
    },
    []
  );

  async function flushSave({ force = false } = {}) {
    if (!issueKeyRef.current) return;
    // A direct call (blur, an immediate persist, unmount cleanup) always
    // supersedes a still-pending debounced one — otherwise the debounce
    // timer fires again later on its own and races this call (see
    // saveInFlightRef above).
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    if (saveInFlightRef.current) {
      // Coalesce: don't start a second request while one's in flight, just
      // remember to rerun once it settles, using whatever's newest at that
      // point (latestDiagramsRef / baseSnapshotRef).
      pendingRerunRef.current = { force: pendingRerunRef.current?.force || force };
      return;
    }

    setSaveState('saving');
    const run = (async () => {
      try {
        const result = await invoke('setFieldValue', {
          issueKey: issueKeyRef.current,
          value: { diagrams: latestDiagramsRef.current },
          baseSnapshot: baseSnapshotRef.current,
          force,
        });
        if (result.conflict) {
          setConflict(result.current);
          setSaveState('idle');
          // A real conflict needs the user to resolve it before another
          // save makes sense — a queued rerun would just hit the same
          // conflict again against the same stale baseSnapshot.
          pendingRerunRef.current = null;
          return;
        }
        baseSnapshotRef.current = result.snapshot;
        setErrorMessage(null);
        setSaveState('saved');
      } catch (err) {
        setErrorMessage(err.message || String(err));
        setSaveState('error');
      }
    })();
    saveInFlightRef.current = run;
    await run;
    saveInFlightRef.current = null;

    if (pendingRerunRef.current) {
      const rerun = pendingRerunRef.current;
      pendingRerunRef.current = null;
      flushSave(rerun);
    }
  }

  function persist(next, { immediate = false } = {}) {
    setDiagrams(next);
    latestDiagramsRef.current = next;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }

    if (payloadSizeBytes(next) > MAX_PROPERTY_BYTES) {
      // Don't even attempt a save that's guaranteed to be rejected — the
      // resolver enforces this too, but failing fast here avoids a wasted
      // invocation and gives immediate feedback.
      setSaveState('too-large');
      setErrorMessage(
        `These diagrams are too large to save (${(payloadSizeBytes(next) / 1024).toFixed(1)} KB of a 32 KB Jira limit). Remove or shrink a diagram to save your changes.`
      );
      return;
    }

    if (immediate) {
      flushSave();
    } else {
      setSaveState('pending');
      saveTimeoutRef.current = setTimeout(() => {
        saveTimeoutRef.current = null;
        flushSave();
      }, SAVE_DEBOUNCE_MS);
    }
  }

  function resolveConflictKeepMine() {
    setConflict(null);
    flushSave({ force: true });
  }

  function resolveConflictDiscardMine() {
    const theirs = (conflict?.diagrams || []).map((d) => ({ theme: 'default', section: '', ...d }));
    baseSnapshotRef.current = stableStringify(conflict);
    setDiagrams(theirs);
    latestDiagramsRef.current = theirs;
    setModes(Object.fromEntries(theirs.map((d) => [d.id, 'display'])));
    setConflict(null);
    setSaveState('idle');
    setErrorMessage(null);
  }

  function addDiagram() {
    // 'brand' rather than 'default': per direct user feedback, an
    // opt-in-only theme choice buried in a dropdown wasn't actually making
    // new diagrams look any different day-to-day. Still only affects
    // diagrams that don't exist yet — no auto-switching of an existing
    // diagram's theme, same rule as the dark/default choice below.
    const template = selectedTemplateId ? templateById(selectedTemplateId) : null;
    const diagram = newDiagram(effectiveDark ? 'dark' : 'brand', template?.source);
    setModes((prev) => ({ ...prev, [diagram.id]: 'edit' }));
    persist([...latestDiagramsRef.current, diagram], { immediate: true });
    setSelectedTemplateId('');
  }

  function startSplitResize(e) {
    e.preventDefault();
    const container = e.currentTarget.parentElement;
    const rect = container.getBoundingClientRect();

    function onMove(moveEvent) {
      const x = moveEvent.clientX - rect.left;
      const raw = (x / rect.width) * 100;
      const stepped = Math.round(raw / 5) * 5;
      setSplitPercent(Math.min(80, Math.max(20, stepped)));
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function nudgeSplit(delta) {
    setSplitPercent((prev) => Math.min(80, Math.max(20, prev + delta)));
  }

  function updateDiagram(id, patch, opts) {
    persist(
      latestDiagramsRef.current.map((d) => (d.id === id ? { ...d, ...patch } : d)),
      opts
    );
  }

  function requestRemove(id) {
    setPendingRemoveId(id);
  }

  function cancelRemove() {
    setPendingRemoveId(null);
  }

  function confirmRemove(id) {
    const index = latestDiagramsRef.current.findIndex((d) => d.id === id);
    if (index === -1) return;
    const removedDiagram = latestDiagramsRef.current[index];

    setPendingRemoveId(null);
    setModes((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setParseErrorLines((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    persist(
      latestDiagramsRef.current.filter((d) => d.id !== id),
      { immediate: true }
    );

    if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current);
    setUndoState({ diagram: removedDiagram, index });
    undoTimeoutRef.current = setTimeout(() => {
      undoTimeoutRef.current = null;
      setUndoState(null);
    }, UNDO_TIMEOUT_MS);
  }

  function undoRemove() {
    if (!undoState) return;
    if (undoTimeoutRef.current) {
      clearTimeout(undoTimeoutRef.current);
      undoTimeoutRef.current = null;
    }
    const restored = [...latestDiagramsRef.current];
    restored.splice(Math.min(undoState.index, restored.length), 0, undoState.diagram);
    setModes((prev) => ({ ...prev, [undoState.diagram.id]: 'display' }));
    setUndoState(null);
    persist(restored, { immediate: true });
  }

  // Deletes a flowchart edge immediately (DiagramCanvas's click-to-delete),
  // same "act now, offer Undo" pattern as confirmRemove/undoRemove above,
  // rather than a confirmation dialog before the delete happens.
  function handleEdgeClick(diagramId, fromId, toId) {
    const diagram = latestDiagramsRef.current.find((d) => d.id === diagramId);
    if (!diagram) return;
    const nextSource = deleteEdge(diagram.source, fromId, toId);
    // deleteEdge no-ops (returns the same string) if it didn't recognize
    // the edge as a single whole line — nothing to delete or undo.
    if (nextSource === diagram.source) return;

    if (edgeUndoTimeoutRef.current) clearTimeout(edgeUndoTimeoutRef.current);
    setEdgeUndoState({ diagramId, prevSource: diagram.source });
    edgeUndoTimeoutRef.current = setTimeout(() => {
      edgeUndoTimeoutRef.current = null;
      setEdgeUndoState(null);
    }, UNDO_TIMEOUT_MS);

    updateDiagram(diagramId, { source: nextSource }, { immediate: true });
  }

  function undoEdgeDelete() {
    if (!edgeUndoState) return;
    if (edgeUndoTimeoutRef.current) {
      clearTimeout(edgeUndoTimeoutRef.current);
      edgeUndoTimeoutRef.current = null;
    }
    updateDiagram(edgeUndoState.diagramId, { source: edgeUndoState.prevSource }, { immediate: true });
    setEdgeUndoState(null);
  }

  function setMode(id, mode) {
    setModes((prev) => ({ ...prev, [id]: mode }));
  }

  function toggleCollapsed(id) {
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function toggleSectionCollapsed(name) {
    setSectionCollapsed((prev) => ({ ...prev, [name]: !prev[name] }));
  }

  function moveDiagram(id, direction) {
    // Reads latestDiagramsRef.current, not the `diagrams` state closure:
    // spamming this button fires several clicks before React re-renders
    // (each click's handler is still bound to whatever `diagrams` closure
    // was current at the last completed render), so a stale `diagrams` read
    // would compute `next` from an outdated array and silently revert the
    // previous click's move when persist() overwrites latestDiagramsRef.current
    // with it. latestDiagramsRef.current is always the true last-applied
    // state (persist() updates it synchronously on every call), so basing
    // the swap on it keeps rapid successive moves additive instead of lossy.
    const current = latestDiagramsRef.current;
    const target = moveTargetIndex(current, id, direction);
    if (target === null) return;
    const index = current.findIndex((d) => d.id === id);
    const next = [...current];
    [next[index], next[target]] = [next[target], next[index]];
    persist(next, { immediate: true });
  }

  if (status === 'loading') {
    return (
      <div className="board-container board-center">
        <Spinner size="large" label="Loading diagram board" />
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="board-container">
        <SectionMessage appearance="error" title="Something went wrong">
          <p>{errorMessage}</p>
        </SectionMessage>
      </div>
    );
  }

  const sizeBytes = payloadSizeBytes(diagrams);
  const nearSizeLimit =
    saveState !== 'too-large' && sizeBytes > MAX_PROPERTY_BYTES * SIZE_WARNING_RATIO;

  // The click-on-the-bubble style popover: the only entry point into
  // per-node/state/entity styling (flowchart/state/ER — see
  // node-style-kind.js; other diagram types have no per-element style
  // mechanism in Mermaid at all, verified against the real parser). An
  // earlier version of this app had a second, docked dropdown+swatches
  // toolbar for the same data; it was removed per direct user feedback
  // once this popover shipped, rather than kept as a parallel entry point —
  // in-diagram click-to-style was judged to fully replace it, not
  // supplement it.
  //
  // Positioned once from the rect DiagramCanvas captured at click time
  // (position: fixed + inline left/top — permitted by manifest.yml's
  // `content.styles: ['unsafe-inline']`, added for CodeMirror). Doesn't
  // re-track the node's position on subsequent pan/zoom; it just closes on
  // the next outside click, Escape, or (implicitly) the pointerdown that
  // starts a new pan, all handled by the document-level effect above.
  function renderNodePopover() {
    if (!nodePopover) return null;
    const diagram = diagrams.find((d) => d.id === nodePopover.diagramId);
    if (!diagram) return null;
    const styleKind = resolveNodeStyleKind(diagram.source);
    // Guards against the popover outliving a source edit that changed the
    // diagram's type or removed the clicked node entirely (e.g. typed over
    // it in the editor while the popover from an earlier click was still
    // open) — silently closes rather than operating on a stale node id.
    if (!styleKind || styleKind.kind !== nodePopover.kind) return null;
    const nodeIds = styleKind.parseIds(diagram.source);
    if (!nodeIds.includes(nodePopover.nodeId)) return null;
    const current = styleKind.parseStyles(diagram.source)[nodePopover.nodeId] || {};

    // Discrete pick (swatch click or border-width preset): applied and
    // saved right away, same as the theme/section pickers elsewhere in this
    // app — there's no drag/continuous gesture here to debounce.
    function applyPopoverStyleImmediate(prop, value) {
      updateDiagram(
        diagram.id,
        { source: styleKind.upsertStyle(diagram.source, nodePopover.nodeId, { [prop]: value }) },
        { immediate: true }
      );
    }

    // Continuous drag (the native color input's onChange fires tens of
    // times a second while dragging — see NODE_COLOR_RENDER_DEBOUNCE_MS
    // above): can't be a plain immediate updateDiagram call, or a color
    // drag on the custom-color fallback would repeat the render/save race
    // that constant documents.
    function applyPopoverStyleDrag(prop, value) {
      scheduleNodeColorUpdate(() => {
        updateDiagram(diagram.id, {
          source: styleKind.upsertStyle(diagram.source, nodePopover.nodeId, { [prop]: value }),
        });
      });
    }

    function flushPopoverAndSave() {
      flushNodeColorUpdate();
      flushSave();
    }

    // One row per channel: a curated swatch palette (QUICK_SWATCHES) as the
    // primary, one-click way to pick a color — plus the native color input
    // kept as a small "custom" fallback for anything outside that set. Per
    // direct user feedback that raw color-picker swatches alone read as
    // "paint," not a design tool.
    function renderColorRow(label, prop, fallback) {
      const value = (current[prop] || fallback).toLowerCase();
      return (
        <div className="node-style-popover-row">
          <span className="node-style-popover-label">{label}</span>
          <div className="swatch-group" role="group" aria-label={`${label} color`}>
            {QUICK_SWATCHES.map((hex) => (
              <button
                key={hex}
                type="button"
                className={`swatch-btn${value === hex ? ' swatch-btn-active' : ''}`}
                style={{ backgroundColor: hex }}
                title={hex}
                aria-label={`${label}: ${hex}`}
                aria-pressed={value === hex}
                onClick={() => applyPopoverStyleImmediate(prop, hex)}
              />
            ))}
            <input
              type="color"
              className="node-color-input swatch-custom-input"
              title="Custom color"
              aria-label={`${label}: custom color`}
              value={current[prop] || fallback}
              onChange={(e) => applyPopoverStyleDrag(prop, e.target.value)}
              onBlur={flushPopoverAndSave}
            />
          </div>
        </div>
      );
    }

    const currentStrokeWidth = current['stroke-width'];

    // Icon-in-label is flowchart-only for now — a state's displayed text
    // and an ER entity's displayed text don't have an equivalent free-text
    // label to prepend an icon to without a bigger, diagram-type-specific
    // rewrite (see node-label.js's own note). Deferred rather than guessed
    // at; the row simply doesn't render for state/ER nodes.
    const currentIcon = styleKind.kind === 'flowchart' ? getNodeIcon(diagram.source, nodePopover.nodeId) : '';

    function applyIcon(icon) {
      updateDiagram(
        diagram.id,
        { source: setNodeIcon(diagram.source, nodePopover.nodeId, icon) },
        { immediate: true }
      );
    }

    const { rect } = nodePopover;
    const style = {
      left: Math.max(8, rect.left + rect.width / 2),
      top: popoverTop,
    };

    return (
      <div className="node-style-popover" ref={nodePopoverRef} style={style}>
        <div className="node-style-popover-header">
          <span className="node-style-popover-title">{nodePopover.nodeId}</span>
          <button
            type="button"
            className="btn btn-subtle btn-icon node-style-popover-close"
            aria-label="Close style popover"
            onClick={() => setNodePopover(null)}
          >
            ×
          </button>
        </div>
        {styleKind.kind === 'flowchart' && (
          <div className="node-style-popover-row">
            <span className="node-style-popover-label">Icon</span>
            <div className="icon-group" role="group" aria-label="Node icon">
              {QUICK_ICONS.map((icon) => (
                <button
                  key={icon}
                  type="button"
                  className={`btn btn-subtle btn-icon icon-btn${currentIcon === icon ? ' icon-btn-active' : ''}`}
                  aria-label={`Icon: ${icon}`}
                  aria-pressed={currentIcon === icon}
                  onClick={() => applyIcon(currentIcon === icon ? '' : icon)}
                >
                  {icon}
                </button>
              ))}
            </div>
          </div>
        )}
        {renderColorRow('Fill', 'fill', '#ffffff')}
        {renderColorRow('Border', 'stroke', '#333333')}
        <div className="node-style-popover-row">
          <span className="node-style-popover-label">Border width</span>
          <div className="border-width-group" role="group" aria-label="Border width">
            {BORDER_WIDTHS.map((px) => (
              <button
                key={px}
                type="button"
                className={`btn btn-subtle btn-icon border-width-btn${
                  currentStrokeWidth === String(px) ? ' border-width-btn-active' : ''
                }`}
                aria-label={`${px}px border`}
                aria-pressed={currentStrokeWidth === String(px)}
                onClick={() => applyPopoverStyleImmediate('stroke-width', String(px))}
              >
                <span className="border-width-preview" data-width={px} />
              </button>
            ))}
          </div>
        </div>
        {renderColorRow('Text', 'color', '#000000')}
        <button
          type="button"
          className="btn btn-subtle node-style-popover-reset"
          onClick={() => {
            let nextSource = styleKind.upsertStyle(diagram.source, nodePopover.nodeId, {
              fill: '',
              stroke: '',
              'stroke-width': '',
              color: '',
            });
            if (styleKind.kind === 'flowchart') {
              nextSource = setNodeIcon(nextSource, nodePopover.nodeId, '');
            }
            updateDiagram(diagram.id, { source: nextSource }, { immediate: true });
          }}
        >
          <span className="node-style-popover-reset-icon" aria-hidden="true">
            ↺
          </span>
          Reset node
        </button>
      </div>
    );
  }

  function renderDiagramCard(diagram) {
    const mode = modes[diagram.id] || 'display';
    const isCollapsed = mode === 'display' && !!collapsed[diagram.id];
    const { canUp, canDown } = moveBounds(diagrams, diagram.id);
    return (
      <div className="diagram-card" key={diagram.id}>
        <div className="diagram-card-header">
          {mode === 'display' && (
            <button
              type="button"
              className="collapse-toggle"
              onClick={() => toggleCollapsed(diagram.id)}
              aria-label={isCollapsed ? 'Expand diagram' : 'Collapse diagram'}
            >
              {isCollapsed ? <ChevronRightIcon label="" /> : <ChevronDownIcon label="" />}
            </button>
          )}
          {mode === 'edit' ? (
            <input
              className="text-input diagram-label-input"
              value={diagram.label ?? ''}
              onChange={(e) => updateDiagram(diagram.id, { label: e.target.value })}
              onBlur={flushSave}
              placeholder="Untitled diagram"
            />
          ) : (
            <h3 className="diagram-title">{diagram.label || 'Untitled diagram'}</h3>
          )}

          <div className="diagram-card-actions">
            {pendingRemoveId === diagram.id ? (
              <>
                <span className="confirm-remove-label">Remove this diagram?</span>
                <button type="button" className="btn btn-danger" onClick={() => confirmRemove(diagram.id)}>
                  Remove
                </button>
                <button type="button" className="btn btn-subtle" onClick={cancelRemove}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-subtle btn-icon"
                  title="Move up"
                  aria-label="Move diagram up"
                  disabled={!canUp}
                  onClick={() => moveDiagram(diagram.id, -1)}
                >
                  <ArrowUpIcon label="" size="small" />
                </button>
                <button
                  type="button"
                  className="btn btn-subtle btn-icon"
                  title="Move down"
                  aria-label="Move diagram down"
                  disabled={!canDown}
                  onClick={() => moveDiagram(diagram.id, 1)}
                >
                  <ArrowDownIcon label="" size="small" />
                </button>
                {mode === 'edit' ? (
                  <button
                    type="button"
                    className="btn btn-primary btn-icon-text"
                    onClick={() => setMode(diagram.id, 'display')}
                  >
                    <CheckIcon label="" size="small" />
                    Done
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-subtle btn-icon-text"
                    onClick={() => setMode(diagram.id, 'edit')}
                  >
                    <EditIcon label="" size="small" />
                    Edit
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-subtle btn-icon btn-remove"
                  title="Remove diagram"
                  aria-label="Remove diagram"
                  onClick={() => requestRemove(diagram.id)}
                >
                  <TrashIcon label="" size="small" />
                </button>
              </>
            )}
          </div>
        </div>

        {mode === 'edit' ? (
          <div className="diagram-card-body diagram-card-body-edit">
            <div className="editor-toolbar">
              <label className="style-picker-label" htmlFor={`theme-${diagram.id}`}>
                Style
              </label>
              <select
                id={`theme-${diagram.id}`}
                className="select-input"
                value={diagram.theme}
                onChange={(e) => updateDiagram(diagram.id, { theme: e.target.value }, { immediate: true })}
              >
                {MERMAID_THEMES.map((theme) => (
                  <option key={theme} value={theme}>
                    {themeLabel(theme)}
                  </option>
                ))}
              </select>
              <label className="style-picker-label" htmlFor={`section-${diagram.id}`}>
                Section
              </label>
              <input
                id={`section-${diagram.id}`}
                className="text-input section-input"
                value={sectionDraft[diagram.id] ?? diagram.section}
                onChange={(e) =>
                  setSectionDraft((prev) => ({ ...prev, [diagram.id]: e.target.value }))
                }
                onBlur={(e) => {
                  setSectionDraft((prev) => {
                    const next = { ...prev };
                    delete next[diagram.id];
                    return next;
                  });
                  // immediate: true both saves right away (rather than
                  // waiting on the debounce) and — same code path as
                  // add/remove/theme — clears any already-pending debounced
                  // save first, so this doesn't also fire a second,
                  // redundant save ~600ms later.
                  updateDiagram(diagram.id, { section: e.target.value }, { immediate: true });
                }}
                placeholder="None"
              />
            </div>
            {(() => {
              // Click-to-insert shape/element palette — only rendered when
              // this diagram's type actually has one (flowchart/sequence so
              // far; resolvePaletteKind returns null for anything else, same
              // "nothing to offer" convention resolveNodeStyleKind already
              // follows for the style popover's per-diagram-type rows).
              const palette = resolvePaletteKind(diagram.source);
              if (!palette) return null;
              return (
                <div className="palette-row" role="group" aria-label="Insert element">
                  {palette.entries.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      className="btn btn-subtle btn-icon palette-btn"
                      title={`Insert ${entry.label}`}
                      aria-label={`Insert ${entry.label}`}
                      onClick={() =>
                        updateDiagram(
                          diagram.id,
                          { source: entry.insert(diagram.source) },
                          { immediate: true }
                        )
                      }
                    >
                      {renderPaletteGlyph(entry.glyph)}
                    </button>
                  ))}
                </div>
              );
            })()}
            <div className="editor-split" data-split={splitPercent}>
              <div className="editor-pane">
                <CodeMirrorEditor
                  value={diagram.source}
                  onChange={(source) => updateDiagram(diagram.id, { source })}
                  onBlur={flushSave}
                  errorLine={parseErrorLines[diagram.id]}
                />
              </div>
              <div
                className="editor-split-divider"
                role="separator"
                aria-orientation="vertical"
                aria-valuenow={splitPercent}
                aria-valuemin={20}
                aria-valuemax={80}
                aria-label="Resize editor and preview"
                tabIndex={0}
                onMouseDown={startSplitResize}
                onDoubleClick={() => setSplitPercent(50)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft') nudgeSplit(-5);
                  if (e.key === 'ArrowRight') nudgeSplit(5);
                }}
              />
              <div className="preview-pane">
                <DiagramErrorBoundary>
                  <DiagramView
                    source={diagram.source}
                    theme={diagram.theme}
                    idPrefix={diagram.id}
                    onNodeClick={(info) => setNodePopover({ diagramId: diagram.id, ...info })}
                    selectedNode={
                      nodePopover && nodePopover.diagramId === diagram.id
                        ? { kind: nodePopover.kind, nodeId: nodePopover.nodeId }
                        : null
                    }
                    onError={(err) =>
                      setParseErrorLines((prev) => ({ ...prev, [diagram.id]: err?.line ?? null }))
                    }
                    connectable={isConnectable(diagram.source)}
                    onConnect={(fromId, toId) =>
                      updateDiagram(
                        diagram.id,
                        { source: connectNodes(diagram.source, fromId, toId) },
                        { immediate: true }
                      )
                    }
                    onEdgeClick={(fromId, toId) => handleEdgeClick(diagram.id, fromId, toId)}
                  />
                </DiagramErrorBoundary>
              </div>
            </div>
          </div>
        ) : (
          !isCollapsed && (
            <div className="diagram-card-body diagram-card-body-display">
              <DiagramErrorBoundary>
                <DiagramView source={diagram.source} theme={diagram.theme} idPrefix={diagram.id} />
              </DiagramErrorBoundary>
            </div>
          )
        )}
      </div>
    );
  }

  return (
    <div className="board-container">
      {conflict && (
        <SectionMessage appearance="warning" title="Someone else changed these diagrams">
          <p>
            These diagrams were updated elsewhere while you were editing. Keeping your changes
            will overwrite theirs; discarding will replace what you see here with their latest
            version.
          </p>
          <div className="conflict-actions">
            <button type="button" className="btn btn-primary" onClick={resolveConflictKeepMine}>
              Keep my changes
            </button>
            <button type="button" className="btn btn-subtle" onClick={resolveConflictDiscardMine}>
              Discard mine, use theirs
            </button>
          </div>
        </SectionMessage>
      )}

      {errorMessage && (
        <SectionMessage
          appearance="warning"
          title={saveState === 'too-large' ? 'Diagrams are too large to save' : 'Save failed'}
        >
          <p>{errorMessage}</p>
        </SectionMessage>
      )}

      {undoState && (
        <div className="undo-banner">
          <span>Diagram removed.</span>
          <button type="button" className="btn btn-subtle" onClick={undoRemove}>
            Undo
          </button>
        </div>
      )}

      {edgeUndoState && (
        <div className="undo-banner">
          <span>Arrow removed.</span>
          <button type="button" className="btn btn-subtle" onClick={undoEdgeDelete}>
            Undo
          </button>
        </div>
      )}

      {diagrams.length === 0 && (
        <SectionMessage appearance="information" title="No diagrams yet">
          <p>Add your first Mermaid diagram to this issue.</p>
        </SectionMessage>
      )}

      {buildRenderGroups(diagrams).map((group) =>
        group.type === 'standalone' ? (
          renderDiagramCard(group.diagram)
        ) : (
          <div className="diagram-section" key={`section-${group.name}`}>
            <button
              type="button"
              className="section-header"
              onClick={() => toggleSectionCollapsed(group.name)}
              aria-label={
                sectionCollapsed[group.name] ? `Expand ${group.name}` : `Collapse ${group.name}`
              }
            >
              {sectionCollapsed[group.name] ? (
                <ChevronRightIcon label="" />
              ) : (
                <ChevronDownIcon label="" />
              )}
              <span className="section-title">{group.name}</span>
              <span className="section-count">{group.items.length}</span>
            </button>
            {!sectionCollapsed[group.name] && (
              <div className="diagram-section-body">
                {group.items.map(({ diagram }) => renderDiagramCard(diagram))}
              </div>
            )}
          </div>
        )
      )}

      <div className="board-actions">
        <div className="add-diagram-control">
          <select
            className="select-input"
            value={selectedTemplateId}
            onChange={(e) => setSelectedTemplateId(e.target.value)}
            aria-label="Diagram template"
          >
            <option value="">Blank flowchart</option>
            {DIAGRAM_TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-primary" onClick={addDiagram}>
            Add a diagram
          </button>
        </div>
        <span className={`save-status save-status-${saveState}`}>
          {saveState === 'saving' && (
            <>
              <Spinner size="small" /> Saving…
            </>
          )}
          {saveState === 'pending' && 'Editing…'}
          {saveState === 'saved' && '✓ Saved'}
          {saveState === 'error' && 'Save failed'}
          {saveState === 'too-large' && 'Too large to save'}
        </span>
        {nearSizeLimit && (
          <span className="save-status size-warning">
            {(sizeBytes / 1024).toFixed(1)} KB / {(MAX_PROPERTY_BYTES / 1024).toFixed(0)} KB
          </span>
        )}
      </div>
      {renderNodePopover()}
    </div>
  );
}
