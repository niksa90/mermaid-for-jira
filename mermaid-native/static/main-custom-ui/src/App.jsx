import React, { useEffect, useRef, useState } from 'react';
import { invoke, view } from '@forge/bridge';
import Spinner from '@atlaskit/spinner';
import SectionMessage from '@atlaskit/section-message';
import TrashIcon from '@atlaskit/icon/glyph/trash';
import EditIcon from '@atlaskit/icon/glyph/edit';
import CheckIcon from '@atlaskit/icon/glyph/check';
import ArrowUpIcon from '@atlaskit/icon/glyph/arrow-up';
import ArrowDownIcon from '@atlaskit/icon/glyph/arrow-down';
import ChevronDownIcon from '@atlaskit/icon/glyph/chevron-down';
import ChevronRightIcon from '@atlaskit/icon/glyph/chevron-right';
import DiagramView from '../../../src/DiagramView';
import DiagramErrorBoundary from '../../../src/ErrorBoundary';
import { MERMAID_THEMES } from '../../../src/mermaid-renderer';
import { stableStringify } from '../../../src/stable-json';
import './styles.css';

const SAVE_DEBOUNCE_MS = 600;
const UNDO_TIMEOUT_MS = 8000;
// Jira Cloud's documented entity-property value size limit (also enforced
// resolver-side — this is just so the UI can warn before attempting a save
// that's guaranteed to fail): https://developer.atlassian.com/cloud/jira/platform/jira-entity-properties/
const MAX_PROPERTY_BYTES = 32768;
const SIZE_WARNING_RATIO = 0.85;

function payloadSizeBytes(diagramsArr) {
  return new TextEncoder().encode(JSON.stringify({ diagrams: diagramsArr })).length;
}

function newDiagram() {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label: 'New diagram',
    source: 'flowchart TD\n  A[Start] --> B[End]',
    theme: 'default',
    section: '',
  };
}

function themeLabel(theme) {
  return theme.charAt(0).toUpperCase() + theme.slice(1);
}

/**
 * Groups diagrams by their `section` field for rendering, without changing
 * how they're stored — `diagrams` stays a flat array (order = real,
 * persisted content), grouping is purely a render-time view over it. A
 * diagram with no section renders standalone; diagrams sharing a section
 * name are clustered together the first time that name appears, regardless
 * of where else in the array a same-named diagram shows up later.
 */
function buildRenderGroups(diagramsArr) {
  const groups = [];
  const sectionAt = new Map();
  diagramsArr.forEach((diagram, index) => {
    const section = (diagram.section || '').trim();
    if (!section) {
      groups.push({ type: 'standalone', diagram, index });
      return;
    }
    if (sectionAt.has(section)) {
      groups[sectionAt.get(section)].items.push({ diagram, index });
    } else {
      sectionAt.set(section, groups.length);
      groups.push({ type: 'section', name: section, items: [{ diagram, index }] });
    }
  });
  return groups;
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

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const context = await view.getContext();
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
    setSaveState('saving');
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
        return;
      }
      baseSnapshotRef.current = result.snapshot;
      setErrorMessage(null);
      setSaveState('saved');
    } catch (err) {
      setErrorMessage(err.message || String(err));
      setSaveState('error');
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
    const diagram = newDiagram();
    setModes((prev) => ({ ...prev, [diagram.id]: 'edit' }));
    persist([...diagrams, diagram], { immediate: true });
  }

  function updateDiagram(id, patch, opts) {
    persist(
      diagrams.map((d) => (d.id === id ? { ...d, ...patch } : d)),
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
    const index = diagrams.findIndex((d) => d.id === id);
    if (index === -1) return;
    const removedDiagram = diagrams[index];

    setPendingRemoveId(null);
    setModes((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    persist(
      diagrams.filter((d) => d.id !== id),
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
    const restored = [...diagrams];
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
    const index = diagrams.findIndex((d) => d.id === id);
    const target = index + direction;
    if (index === -1 || target < 0 || target >= diagrams.length) return;
    const next = [...diagrams];
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

  function renderDiagramCard(diagram, diagramIndex) {
    const mode = modes[diagram.id] || 'display';
    const isCollapsed = mode === 'display' && !!collapsed[diagram.id];
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
              value={diagram.label}
              onChange={(e) => updateDiagram(diagram.id, { label: e.target.value })}
              onBlur={flushSave}
              placeholder="Diagram label"
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
                  disabled={diagramIndex === 0}
                  onClick={() => moveDiagram(diagram.id, -1)}
                >
                  <ArrowUpIcon label="" size="small" />
                </button>
                <button
                  type="button"
                  className="btn btn-subtle btn-icon"
                  title="Move down"
                  aria-label="Move diagram down"
                  disabled={diagramIndex === diagrams.length - 1}
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
            <div className="editor-split">
              <div className="editor-pane">
                <textarea
                  className="mermaid-textarea"
                  value={diagram.source}
                  onChange={(e) => updateDiagram(diagram.id, { source: e.target.value })}
                  onBlur={flushSave}
                  spellCheck={false}
                />
              </div>
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
          renderDiagramCard(group.diagram, group.index)
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
                {group.items.map(({ diagram, index }) => renderDiagramCard(diagram, index))}
              </div>
            )}
          </div>
        )
      )}

      <div className="board-actions">
        <button type="button" className="btn btn-primary" onClick={addDiagram}>
          Add a diagram
        </button>
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
