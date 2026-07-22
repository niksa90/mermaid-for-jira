import React, { useEffect, useRef, useState } from 'react';
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
} from '../../../src/icons';
import DiagramView from '../../../src/DiagramView';
import DiagramErrorBoundary from '../../../src/ErrorBoundary';
import { MERMAID_THEMES } from '../../../src/mermaid-renderer';
import { DIAGRAM_TEMPLATES, templateById } from '../../../src/diagram-templates';
import { stableStringify } from '../../../src/stable-json';
import { buildRenderGroups, moveTargetIndex, moveBounds } from '../../../src/diagram-groups';
import {
  isFlowchartSource,
  parseFlowchartNodeIds,
  parseNodeStyles,
  upsertNodeStyle,
} from '../../../src/node-style';
import {
  isStateDiagramSource,
  parseStateIds,
  parseStateStyles,
  upsertStateStyle,
} from '../../../src/state-style';
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
  // Which node the per-node color picker is currently pointed at, per
  // diagram — a view preference (which node's colors you're looking at),
  // not diagram content, so client-only like modes/collapsed above.
  const [selectedNode, setSelectedNode] = useState({});
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
  // Most recently removed diagram, kept around briefly so the removal can
  // be undone: { diagram, index } — index is where it lived so undo puts it
  // back in the same place rather than at the end of the list.
  const [undoState, setUndoState] = useState(null);

  const issueKeyRef = useRef(null);
  const saveTimeoutRef = useRef(null);
  const undoTimeoutRef = useRef(null);
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

  // Per-node fill/border/text color picker, shown in edit mode for
  // flowchart and state diagrams with at least one node/state the parser
  // could identify (see node-style.js / state-style.js). Other diagram
  // types (sequence, ER, pie, gantt, ...) don't get this picker at all —
  // Mermaid itself has no per-node style mechanism for them, verified
  // against the real parser rather than assumed, not just a gap in this
  // code.
  //
  // Flowcharts and state diagrams need genuinely different source syntax
  // (flowchart's single `style NodeId ...` line vs. state diagram's
  // two-line `classDef` + `class` pair — state diagrams reject the
  // flowchart syntax outright), so the parse/read/write functions are
  // swapped based on diagram type while the picker UI itself stays one
  // shared implementation.
  function renderNodeColorPicker(diagram) {
    let nodeIds;
    let parseStyles;
    let upsertStyle;
    if (isFlowchartSource(diagram.source)) {
      nodeIds = parseFlowchartNodeIds(diagram.source);
      parseStyles = parseNodeStyles;
      upsertStyle = upsertNodeStyle;
    } else if (isStateDiagramSource(diagram.source)) {
      nodeIds = parseStateIds(diagram.source);
      parseStyles = parseStateStyles;
      upsertStyle = upsertStateStyle;
    } else {
      return null;
    }
    if (nodeIds.length === 0) return null;

    const currentNode =
      selectedNode[diagram.id] && nodeIds.includes(selectedNode[diagram.id])
        ? selectedNode[diagram.id]
        : nodeIds[0];
    const current = parseStyles(diagram.source)[currentNode] || {};

    // Not { immediate: true }: a native color <input> fires onChange
    // continuously while its picker is being dragged (many times a second,
    // not once on release), same as continuous typing in the source
    // textarea — so this goes through the debounced path and flushes on
    // blur, instead of firing a separate immediate save per drag tick.
    // Racing that many concurrent immediate saves against each other used
    // to trip the app's own optimistic-concurrency check (each save reads
    // baseSnapshotRef before any of the earlier in-flight ones had
    // completed), surfacing as a spurious "someone else changed this"
    // conflict against the app's own rapid-fire edits.
    //
    // That debounce only ever throttled the network save, though — every
    // onChange tick still updated `diagram.source` immediately, and
    // DiagramView re-renders (a full mermaid.render()) any time `source`
    // changes. A color drag was therefore triggering a full Mermaid
    // re-render on every single tick with nothing capping the rate, which
    // was enough to lock up the whole machine on a real diagram (see
    // NODE_COLOR_RENDER_DEBOUNCE_MS above). scheduleNodeColorUpdate throttles
    // the actual `diagram.source` commit the same way; only the last color
    // value in a burst of drag ticks ends up applied.
    function applyNodeStyle(prop, value) {
      scheduleNodeColorUpdate(() => {
        updateDiagram(diagram.id, {
          source: upsertStyle(diagram.source, currentNode, { [prop]: value }),
        });
      });
    }

    function flushNodeColorAndSave() {
      flushNodeColorUpdate();
      flushSave();
    }

    return (
      <div className="node-style-toolbar">
        <label className="style-picker-label" htmlFor={`node-${diagram.id}`}>
          Node
        </label>
        <select
          id={`node-${diagram.id}`}
          className="select-input"
          value={currentNode}
          onChange={(e) => setSelectedNode((prev) => ({ ...prev, [diagram.id]: e.target.value }))}
        >
          {nodeIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <label className="node-color-label">
          Fill
          <input
            type="color"
            className="node-color-input"
            value={current.fill || '#ffffff'}
            onChange={(e) => applyNodeStyle('fill', e.target.value)}
            onBlur={flushNodeColorAndSave}
          />
        </label>
        <label className="node-color-label">
          Border
          <input
            type="color"
            className="node-color-input"
            value={current.stroke || '#333333'}
            onChange={(e) => applyNodeStyle('stroke', e.target.value)}
            onBlur={flushNodeColorAndSave}
          />
        </label>
        <label className="node-color-label">
          Text
          <input
            type="color"
            className="node-color-input"
            value={current.color || '#000000'}
            onChange={(e) => applyNodeStyle('color', e.target.value)}
            onBlur={flushNodeColorAndSave}
          />
        </label>
        <button
          type="button"
          className="btn btn-subtle"
          onClick={() =>
            updateDiagram(
              diagram.id,
              {
                source: upsertStyle(diagram.source, currentNode, {
                  fill: '',
                  stroke: '',
                  color: '',
                }),
              },
              { immediate: true }
            )
          }
        >
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
            {renderNodeColorPicker(diagram)}
            <div className="editor-split" data-split={splitPercent}>
              <div className="editor-pane">
                <textarea
                  className="mermaid-textarea"
                  value={diagram.source}
                  onChange={(e) => updateDiagram(diagram.id, { source: e.target.value })}
                  onBlur={flushSave}
                  spellCheck={false}
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
                  <DiagramView source={diagram.source} theme={diagram.theme} idPrefix={diagram.id} />
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
    </div>
  );
}
