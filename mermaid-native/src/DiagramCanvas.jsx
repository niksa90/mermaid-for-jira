import React, { useEffect, useRef, useState } from 'react';
import { VidFullScreenOnIcon, VidFullScreenOffIcon } from './icons';
import { isDarkMermaidTheme } from './mermaid-renderer';
import {
  extractClickedNodeId,
  extractClickedEdgeId,
  extractClickedClassEdgeId,
  extractClickedErEdgeId,
  extractClickedStateEdgeIndex,
} from './svg-node-id';

const ZOOM_STEP = 1.25;
const MIN_SCALE = 0.2;
const MAX_SCALE = 8;
// Below this much pointer movement (in screen px), a pointerdown/pointerup
// pair counts as a click on whatever was under it rather than a pan-drag —
// without this, any single-pixel jitter during a click (unavoidable with a
// mouse) would always read as "the user panned, not clicked" and the
// click-to-style popover (onNodeClick) would never fire.
const CLICK_MOVE_THRESHOLD = 6;
// Grace delay before the connect handle disappears after the pointer
// leaves a node — see onPointerMove's hover-tracking for why this can't be
// instant.
const HOVER_CLEAR_GRACE_MS = 350;

// Each diagram kind renders edges under its own CSS class (confirmed via
// jsdom scratch render) — used both to widen click hit areas and to
// dispatch edge-click detection to the right id-extraction function below.
// Sequence messages carry no plain `id` attribute at all (see
// diagram-connect.js's header comment) — `data-et="message"` is what both
// selects them and marks that a match is a message, not (say) a
// control-structure wrapper. The widened-hit-area clone below copies this
// attribute along with everything else, so the selector also matches its
// own clones; extractSequenceMessageOrdinal (below) accounts for that.
const EDGE_SELECTORS = {
  flowchart: '.flowchart-link[id]',
  state: '.transition[id]',
  class: '.relation[id]',
  er: '.relationshipLine[id]',
  sequence: '[data-et="message"]',
};

// Sequence's own node-equivalent: a participant/actor's TOP box (see
// diagram-connect.js's header comment for why only the top one qualifies).
const SEQUENCE_PARTICIPANT_SELECTOR = '[data-et="participant"][data-id]';

/**
 * Resolves a pointer target to `{ kind, nodeId, target }` for whichever
 * diagram type `connectKind` describes, or `null`. Every kind but sequence
 * shares one scheme (a `.node[id]` group whose DOM id encodes both a marker
 * and the source id — see extractClickedNodeId); sequence doesn't fit that
 * scheme at all — its participant boxes already carry the source id as a
 * plain `data-id` attribute, so there's nothing to string-parse, just a
 * direct read. `connectKind` may be null (a diagram type with no connect
 * support at all) or missing `kind` entirely — both fall through to the
 * generic `.node[id]` branch, matching this function's pre-sequence
 * behavior of just trying that selector unconditionally.
 */
function resolveNodeTarget(el, connectKind) {
  if (!el?.closest) return null;
  if (connectKind?.kind === 'sequence') {
    const target = el.closest(SEQUENCE_PARTICIPANT_SELECTOR);
    const nodeId = target?.getAttribute('data-id');
    return nodeId ? { kind: 'sequence', nodeId, target } : null;
  }
  const target = el.closest('.node[id]');
  if (!target) return null;
  const resolved = extractClickedNodeId(target.getAttribute('id'));
  return resolved ? { kind: resolved.kind, nodeId: resolved.nodeId, target } : null;
}

/**
 * Resolves a clicked sequence message element (original or its own
 * widened-hit-area clone — see the widening effect below) to its 0-based
 * ordinal among message lines, matching diagram-connect.js's
 * parseSequenceMessages ordering. Can't use DOM position directly
 * (`Array.from(...).indexOf(edgeTarget)`) — the widening effect's clone
 * carries every attribute the original has, including `data-id`, so each
 * message is really two elements back to back in document order; this
 * dedupes by `data-id` first; then locates edgeTarget's own `data-id`
 * within that deduped, order-preserved list.
 */
function extractSequenceMessageOrdinal(container, edgeTarget, selector) {
  const seenIds = [];
  const seen = new Set();
  container.querySelectorAll(selector).forEach((el) => {
    const dataId = el.getAttribute('data-id');
    if (dataId && !seen.has(dataId)) {
      seen.add(dataId);
      seenIds.push(dataId);
    }
  });
  const ordinal = seenIds.indexOf(edgeTarget.getAttribute('data-id'));
  return ordinal === -1 ? null : ordinal;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Wraps a rendered Mermaid SVG string with ctrl/cmd-wheel-zoom,
 * drag-to-pan, and +/-/reset controls. A plain wheel (no modifier) is left
 * alone so the page can scroll past the diagram instead of zooming it.
 *
 * Pan/zoom is implemented by rewriting the SVG's own `viewBox` attribute,
 * not a CSS `transform`/inline `style` — Forge Custom UI's CSP blocks
 * inline style attributes (the reason `mermaid-renderer.js` bakes colors
 * into presentation attributes instead of a <style> block). viewBox is a
 * plain SVG attribute, so it isn't affected.
 */
export default function DiagramCanvas({
  svg,
  theme = 'default',
  onNodeClick,
  selectedNode,
  // What the connect gesture can offer for this diagram's source right now
  // — diagram-connect.js's resolveConnectKind() result, or null. Node
  // hover/drag/click-click detection below works identically for every
  // supported kind (every node group shares the plain `.node` CSS class
  // regardless of diagram type), so connectKind only needs branching for
  // edge *click* detection, which uses a different CSS selector and id
  // scheme per kind (see handleNodeClick). When null, none of the
  // hover-dot/drag machinery attaches at all — same "don't render controls
  // a diagram type can't use" convention as the per-node style popover.
  connectKind = null,
  // The diagram's own declared class names (diagram-connect.js's
  // parseClassIds) — only meaningful when connectKind.kind === 'class',
  // needed to disambiguate a clicked class-relationship's two endpoints
  // (see extractClickedClassEdgeId).
  knownIds,
  // Called with (fromNodeId, toNodeId) once a connect gesture completes
  // against a valid, different target node.
  onConnect,
  // Called with `{ kind, fromId, toId, rect }` (or, for state diagrams,
  // `{ kind: 'state', edgeIndex, rect }` — state edges carry no endpoint
  // info in their DOM id at all, see extractClickedStateEdgeIndex) when an
  // existing edge/relationship/transition is clicked. App.jsx opens the
  // edge popover from this rather than deleting immediately, so the user
  // can restyle (class/ER) or delete from one place. Only wired up when
  // connectKind is set, same scope as the connect gesture itself.
  onEdgeClick,
  // Called with `{ kind, nodeId, rect }` when a node/participant is
  // double-clicked — App.jsx opens the double-click-to-edit-text popover
  // from this (see node-text.js). Reuses connectKind purely to pick the
  // right node-detection scheme via resolveNodeTarget (every kind
  // node-text.js supports already has a connectKind entry, so no separate
  // prop is needed here) — DiagramCanvas itself has no notion of "text
  // editing," it just resolves what got double-clicked.
  onNodeDoubleClick,
}) {
  const connectable = !!connectKind;
  const wrapRef = useRef(null);
  const containerRef = useRef(null);
  const svgElRef = useRef(null);
  const baseViewBoxRef = useRef(null); // natural {minX, minY, width, height}
  const viewRef = useRef(null); // current {minX, minY, width, height}
  const dragRef = useRef(null);
  const [isPanning, setIsPanning] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // Live zoom readout for the combined pill control (viewRef/baseViewBoxRef
  // are plain refs the SVG-attribute pan/zoom mutates directly, precisely
  // so panning/zooming itself doesn't cost a React re-render on every wheel
  // tick — this is the one place that *does* need a render, so it's tracked
  // separately rather than promoting those refs to state wholesale).
  const [zoomPercent, setZoomPercent] = useState(100);
  // Click/drag-to-connect (diagram-connect.js's connectNodes). Kept
  // entirely separate from dragRef/pan state above rather than threaded
  // through it — the two gestures start from different elements (the
  // container vs. a small connect-handle overlay) and mixing their state
  // machines is where subtle interaction bugs live.
  //
  // hoveredNode: { nodeId, rect } | null — whatever node is currently under
  // the pointer, tracked whenever connectable is true (used to show either
  // the idle hover handle, or — while a gesture is active — a "drop here"
  // highlight on the node currently under the pointer).
  const [hoveredNode, setHoveredNode] = useState(null);
  // Set while the connect handle is actively held down and dragged (see
  // onConnectHandlePointerDown) — { fromNodeId, fromRect, pointer }.
  // Rendered as a live rubber-band line from fromRect to pointer.
  const [activeConnectDrag, setActiveConnectDrag] = useState(null);
  // Set instead of the above when the handle was *clicked* (released
  // without moving past the click threshold) rather than dragged — the
  // "click one dot, then click another node" alternative to dragging.
  // { nodeId, rect }. The line still follows the pointer (via the
  // container's own onPointerMove, extended below), it's just not tied to
  // a held-down button anymore.
  const [pendingConnectFrom, setPendingConnectFrom] = useState(null);
  const [pendingPointer, setPendingPointer] = useState(null);
  // See onPointerMove's HOVER_CLEAR_GRACE_MS usage.
  const hoverClearTimeoutRef = useRef(null);

  useEffect(
    () => () => {
      if (hoverClearTimeoutRef.current) clearTimeout(hoverClearTimeoutRef.current);
    },
    []
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const svgEl = container.querySelector('svg');
    svgElRef.current = svgEl;
    if (!svgEl) return;

    let box = svgEl.viewBox && svgEl.viewBox.baseVal;
    if (!box || !box.width || !box.height) {
      const width = parseFloat(svgEl.getAttribute('width')) || svgEl.clientWidth || 300;
      const height = parseFloat(svgEl.getAttribute('height')) || svgEl.clientHeight || 150;
      svgEl.setAttribute('viewBox', `0 0 ${width} ${height}`);
      box = { x: 0, y: 0, width, height };
    }
    baseViewBoxRef.current = { minX: box.x, minY: box.y, width: box.width, height: box.height };
    viewRef.current = { ...baseViewBoxRef.current };
    svgEl.setAttribute('width', '100%');
    svgEl.setAttribute('height', '100%');
    svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    applyView();
    setZoomPercent(100);
  }, [svg]);

  // Mermaid's own edge/relationship/transition strokes render thin (often
  // 1-2px) — clicking one to open the edge popover was reported as "you can
  // barely click on them." Widens the *hit area* without changing the
  // visible line: for each edge matching this diagram kind's own CSS class,
  // clones it into an invisible sibling path with a much fatter
  // `stroke-width`, sharing the same `d`, `class`, and `id` (so
  // handleNodeClick's `closest('<selector>[id]')` + id-extraction logic
  // below works unchanged against either element) but `stroke="transparent"`
  // and no markers, so it adds no visible pixels of its own — it only
  // exists to be a bigger target for the pointer to land on. Inserted right
  // after the original so it paints on top and wins the hit-test.
  //
  // Depends on `connectKind?.kind` (a stable primitive), NOT the whole
  // `connectKind` object — App.jsx passes `connectKind={resolveConnectKind(
  // diagram.source)}`, a brand-new object literal on *every* App.jsx
  // render, whether or not diagram.source actually changed (e.g. typing
  // into this app's own Section field, or the label popover's non-ER
  // fields, re-renders App.jsx per keystroke without touching this
  // diagram's source at all). Depending on the object itself used to
  // re-run this effect on every one of those unrelated re-renders — and
  // since `svg`'s DOM hadn't changed, there was nothing to stop it cloning
  // a *second* hit-area on top of the first, then a third, unboundedly, for
  // as long as the user kept typing. A real, reported browser hang — the
  // same root-cause class (an effect re-firing far faster, and far more
  // often, than anyone intended) as the NODE_COLOR_RENDER_DEBOUNCE_MS bug
  // documented elsewhere in this app, just triggered by prop-identity churn
  // instead of a fast-firing native event. The `data-hit-clone` marker
  // below is a second, independent safety net: even if this effect is ever
  // made to depend on something unstable again, skipping any edge that
  // already has its own marked clone caches this from re-cloning instead of
  // relying solely on the dependency array being right.
  useEffect(() => {
    const container = containerRef.current;
    const kind = connectKind?.kind;
    const selector = kind && EDGE_SELECTORS[kind];
    if (!container || !selector) return;
    container.querySelectorAll(selector).forEach((path) => {
      // The clone itself matches `selector` too (cloneNode copies the
      // matched attribute along with everything else), so without this
      // check a re-run would also treat a previous run's *clone* as a
      // source to clone again — turning the marker check below into linear
      // (not fully suppressed) growth instead of a hard cap at one clone
      // per real edge.
      if (path.hasAttribute('data-hit-clone')) return;
      if (path.nextSibling?.hasAttribute?.('data-hit-clone')) return;
      const hitPath = path.cloneNode(false);
      hitPath.removeAttribute('style');
      hitPath.removeAttribute('marker-start');
      hitPath.removeAttribute('marker-end');
      hitPath.setAttribute('fill', 'none');
      hitPath.setAttribute('stroke', 'transparent');
      hitPath.setAttribute('stroke-width', '14');
      hitPath.setAttribute('pointer-events', 'stroke');
      hitPath.setAttribute('data-hit-clone', '1');
      path.parentNode.insertBefore(hitPath, path.nextSibling);
    });
  }, [svg, connectKind?.kind]);

  // A narrower view (viewRef.width) than the diagram's natural size
  // (baseViewBoxRef.width) means zoomed in, hence the inverse ratio.
  function syncZoomPercent() {
    const base = baseViewBoxRef.current;
    const v = viewRef.current;
    if (!base || !v) return;
    setZoomPercent(Math.round((base.width / v.width) * 100));
  }

  // Visual selection highlight for the click-to-style popover — a Miro-like
  // "this is what you're editing" affordance the raw node-color-picker
  // dropdown never had. Re-derived from scratch after every render (keyed
  // on both `svg` and `selectedNode`) rather than a one-time DOM mutation,
  // because `dangerouslySetInnerHTML` fully replaces the SVG's DOM every
  // time `svg` changes (e.g. after a color/border-width edit), which would
  // otherwise silently drop the highlight class on the very next edit to
  // the node the user is actively styling. Matches the clicked node back up
  // via the same marker-based id scheme handleNodeClick uses, not a live
  // element reference (there isn't one to keep across a full innerHTML
  // replacement).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.querySelectorAll('.node-style-selected').forEach((el) => {
      el.classList.remove('node-style-selected');
    });
    if (!selectedNode) return;
    container.querySelectorAll('.node[id]').forEach((el) => {
      const resolved = extractClickedNodeId(el.getAttribute('id'));
      if (resolved && resolved.kind === selectedNode.kind && resolved.nodeId === selectedNode.nodeId) {
        el.classList.add('node-style-selected');
      }
    });
  }, [svg, selectedNode]);

  function applyView() {
    const svgEl = svgElRef.current;
    const v = viewRef.current;
    if (!svgEl || !v) return;
    svgEl.setAttribute('viewBox', `${v.minX} ${v.minY} ${v.width} ${v.height}`);
  }

  function zoomAt(factor, clientX, clientY) {
    const svgEl = svgElRef.current;
    const v = viewRef.current;
    const base = baseViewBoxRef.current;
    if (!svgEl || !v || !base) return;

    const newWidth = clamp(v.width / factor, base.width / MAX_SCALE, base.width / MIN_SCALE);
    const newHeight = newWidth * (v.height / v.width);

    let ratioX = 0.5;
    let ratioY = 0.5;
    const rect = svgEl.getBoundingClientRect();
    if (clientX != null && rect.width) {
      ratioX = (clientX - rect.left) / rect.width;
      ratioY = (clientY - rect.top) / rect.height;
    }
    const cx = v.minX + v.width * ratioX;
    const cy = v.minY + v.height * ratioY;

    viewRef.current = {
      minX: cx - newWidth * ratioX,
      minY: cy - newHeight * ratioY,
      width: newWidth,
      height: newHeight,
    };
    applyView();
    syncZoomPercent();
  }

  function resetView() {
    if (!baseViewBoxRef.current) return;
    viewRef.current = { ...baseViewBoxRef.current };
    applyView();
    setZoomPercent(100);
  }

  // Double-click resets zoom (the pre-existing behavior) *unless* it landed
  // on a node/participant, in which case it opens the label popover
  // instead — checked first so the two gestures don't collide on the same
  // container-level event.
  function onContainerDoubleClick(e) {
    const hit = resolveNodeTarget(e.target, connectKind);
    if (hit && onNodeDoubleClick) {
      onNodeDoubleClick({ kind: hit.kind, nodeId: hit.nodeId, rect: hit.target.getBoundingClientRect() });
      return;
    }
    resetView();
  }

  // Attached manually (not React's onWheel): React treats wheel listeners
  // as passive by default, which silently no-ops preventDefault() and lets
  // the page scroll instead of zooming.
  //
  // Only ctrlKey/metaKey wheel events zoom (the same modifier browsers use
  // for trackpad pinch-zoom). A plain wheel event falls through untouched
  // so the page can scroll past a diagram — with several diagrams stacked
  // in the panel, unconditionally capturing every wheel event here used to
  // make it impossible to scroll from one diagram to the next.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    function onWheel(e) {
      if (!viewRef.current || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      zoomAt(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, e.clientX, e.clientY);
    }
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, []);

  function onPointerDown(e) {
    if (!viewRef.current) return;
    e.preventDefault();
    dragRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      startMinX: viewRef.current.minX,
      startMinY: viewRef.current.minY,
      moved: false,
      // Captured now, before setPointerCapture below retargets every
      // subsequent event for this pointer (including pointerup) to
      // e.currentTarget (the container div) per the Pointer Events spec —
      // by pointerup time, e.target is no longer the actual SVG element
      // under the cursor, so the real hit-tested element has to be grabbed
      // here instead or handleNodeClick would always find nothing.
      downTarget: e.target,
    };
    setIsPanning(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e) {
    // Idle hover-handle discovery, and live-tracking the pointer for a
    // pending click-click connect — both need to run even when nothing is
    // being dragged, unlike the pan logic below. Skipped while an actual
    // pan is in progress (dragRef.current set): stale coordinates while
    // panning aren't worth tracking, same reasoning as the popover closing
    // on any pan-starting interaction elsewhere in this app.
    if (connectable && !dragRef.current) {
      if (pendingConnectFrom) {
        setPendingPointer({ x: e.clientX, y: e.clientY });
      }
      const hit = resolveNodeTarget(e.target, connectKind);
      if (hit) {
        if (hoverClearTimeoutRef.current) {
          clearTimeout(hoverClearTimeoutRef.current);
          hoverClearTimeoutRef.current = null;
        }
        setHoveredNode({ nodeId: hit.nodeId, rect: hit.target.getBoundingClientRect() });
      } else if (!hoverClearTimeoutRef.current) {
        // Not over a node right now — but don't clear immediately. A
        // shape's rendered outline can sit well inside its bounding box
        // (a diamond's corners, for instance — see the connect handle's
        // own positioning), so reaching the handle means crossing empty
        // space that isn't `.node[id]` at all. Clearing on the spot made
        // the handle disappear before the pointer ever reached it —
        // a real "this isn't clickable" bug report, not a hypothetical.
        // A short grace delay lets that crossing finish; it's cancelled
        // above the moment the pointer re-enters a node (this one or any
        // other), so it never causes a stale handle to linger visibly.
        hoverClearTimeoutRef.current = setTimeout(() => {
          hoverClearTimeoutRef.current = null;
          setHoveredNode(null);
        }, HOVER_CLEAR_GRACE_MS);
      }
    }

    if (!dragRef.current || !svgElRef.current || !viewRef.current) return;
    const rect = svgElRef.current.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dx = e.clientX - dragRef.current.startClientX;
    const dy = e.clientY - dragRef.current.startClientY;
    if (Math.abs(dx) > CLICK_MOVE_THRESHOLD || Math.abs(dy) > CLICK_MOVE_THRESHOLD) {
      dragRef.current.moved = true;
      // A genuine pan started mid-gesture — cancel any pending click-click
      // connect and the stale hover handle rather than leaving them on
      // screen once the user's clearly panning, not completing a connect.
      if (pendingConnectFrom) {
        setPendingConnectFrom(null);
        setPendingPointer(null);
      }
      setHoveredNode(null);
    }
    const v = viewRef.current;
    const dxUnits = (dx / rect.width) * v.width;
    const dyUnits = (dy / rect.height) * v.height;
    viewRef.current = {
      ...v,
      minX: dragRef.current.startMinX - dxUnits,
      minY: dragRef.current.startMinY - dyUnits,
    };
    applyView();
  }

  // Starts a connect gesture from a hovered node's connect handle (see the
  // JSX below) — deliberately not routed through dragRef/onPointerDown
  // above (a *separate* gesture from panning, starting from a different
  // element, tracked via its own plain document-level listeners scoped
  // exactly to this one gesture's lifetime, the standard vanilla-JS drag
  // pattern). stopPropagation on the handle's own pointerdown (see JSX)
  // keeps this from also engaging the container's pan handling.
  function onConnectHandlePointerDown(e, fromNodeId, fromRect) {
    // A gesture is genuinely starting now — clear any pending grace-delay
    // hover-clear (see onPointerMove) so it can't fire mid-gesture and wipe
    // out the hoveredNode state the drag/pending-click logic below relies
    // on for the drop-target highlight.
    if (hoverClearTimeoutRef.current) {
      clearTimeout(hoverClearTimeoutRef.current);
      hoverClearTimeoutRef.current = null;
    }
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;
    setActiveConnectDrag({ fromNodeId, fromRect, pointer: { x: startX, y: startY } });

    function resolveNodeAt(x, y) {
      const el = document.elementFromPoint(x, y);
      return resolveNodeTarget(el, connectKind);
    }

    function onMove(moveEvent) {
      if (
        !moved &&
        (Math.abs(moveEvent.clientX - startX) > CLICK_MOVE_THRESHOLD ||
          Math.abs(moveEvent.clientY - startY) > CLICK_MOVE_THRESHOLD)
      ) {
        moved = true;
      }
      setActiveConnectDrag((prev) => (prev ? { ...prev, pointer: { x: moveEvent.clientX, y: moveEvent.clientY } } : prev));
      // The container's own onPointerMove won't fire for these
      // document-level events, so the drop-target highlight is kept in
      // sync here instead, using the same hoveredNode state it reads from.
      const hit = resolveNodeAt(moveEvent.clientX, moveEvent.clientY);
      setHoveredNode(hit ? { nodeId: hit.nodeId, rect: hit.target.getBoundingClientRect() } : null);
    }

    function onUp(upEvent) {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      setActiveConnectDrag(null);
      if (moved) {
        const hit = resolveNodeAt(upEvent.clientX, upEvent.clientY);
        if (hit && hit.nodeId !== fromNodeId) {
          onConnect?.(fromNodeId, hit.nodeId);
        }
      } else {
        // A plain click on the handle, not a drag — enter click-click mode:
        // remember the source node and wait for a second click elsewhere
        // (handleNodeClick below) to complete or cancel it.
        setPendingConnectFrom({ nodeId: fromNodeId, rect: fromRect });
        setPendingPointer({ x: upEvent.clientX, y: upEvent.clientY });
      }
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  function endDrag(e) {
    dragRef.current = null;
    setIsPanning(false);
    if (e?.currentTarget?.releasePointerCapture) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // pointer capture already released
      }
    }
  }

  // Click vs. pan disambiguation: a pointerdown/pointerup pair that never
  // moved past CLICK_MOVE_THRESHOLD is treated as a click on whatever node
  // was under the pointer, not a pan-drag. Deliberately not a native `click`
  // listener — this reuses the same drag-tracking state onPointerMove
  // already maintains rather than needing a second, parallel mechanism to
  // detect "did this gesture pan the view".
  function onPointerUp(e) {
    const drag = dragRef.current;
    const wasClick = !!drag && !drag.moved;
    endDrag(e);
    if (wasClick) handleNodeClick(drag.downTarget);
  }

  // Resolves a click to a source node/state/entity id (see svg-node-id.js)
  // and reports it upward via onNodeClick, which decides whether the
  // clicked diagram/node actually has a style mechanism to open a popover
  // for. Silently does nothing if the click landed on an edge, a label, a
  // cluster wrapper, or a diagram type with no per-element style mechanism
  // — same "silent no-op for unsupported cases" convention as the rest of
  // this app's Mermaid-CSP workarounds. Takes the pointerdown-time hit
  // target explicitly (see onPointerDown's downTarget) rather than reading
  // it off the pointerup event, since pointer capture has retargeted that
  // event's own .target to the container by now.
  function handleNodeClick(downTarget) {
    // A click-click connect is waiting on this exact click — it takes over
    // completely rather than falling through to the style popover below.
    // Clicking anywhere else (empty canvas, or the source node again)
    // still clears the pending state; it just doesn't call onConnect for a
    // no-op self-connection.
    if (pendingConnectFrom) {
      const hit = resolveNodeTarget(downTarget, connectKind);
      if (hit && hit.nodeId !== pendingConnectFrom.nodeId) {
        onConnect?.(pendingConnectFrom.nodeId, hit.nodeId);
      }
      setPendingConnectFrom(null);
      setPendingPointer(null);
      return;
    }
    if (!downTarget?.closest) return;
    const hit = resolveNodeTarget(downTarget, connectKind);
    if (hit) {
      if (onNodeClick) onNodeClick({ kind: hit.kind, nodeId: hit.nodeId, rect: hit.target.getBoundingClientRect() });
      return;
    }

    // Not a node — check whether it's an edge/relationship/transition/
    // message instead (opens the edge popover). Each diagram kind renders
    // edges under a different CSS class/attribute and DOM id scheme
    // (confirmed via jsdom scratch render), so both the selector and the
    // id-extraction function are picked per connectKind.kind rather than
    // one shared attempt.
    if (connectKind && onEdgeClick) {
      const selector = EDGE_SELECTORS[connectKind.kind];
      const edgeTarget = selector && downTarget.closest(selector);
      let resolvedEdge = null;
      if (edgeTarget) {
        if (connectKind.kind === 'flowchart') {
          resolvedEdge = extractClickedEdgeId(edgeTarget.getAttribute('id'));
        } else if (connectKind.kind === 'state') {
          const edgeIndex = extractClickedStateEdgeIndex(edgeTarget.getAttribute('id'));
          resolvedEdge = edgeIndex != null ? { edgeIndex } : null;
        } else if (connectKind.kind === 'class') {
          resolvedEdge = extractClickedClassEdgeId(edgeTarget.getAttribute('id'), knownIds);
        } else if (connectKind.kind === 'er') {
          resolvedEdge = extractClickedErEdgeId(edgeTarget.getAttribute('id'));
        } else if (connectKind.kind === 'sequence') {
          const ordinal = extractSequenceMessageOrdinal(containerRef.current, edgeTarget, selector);
          resolvedEdge =
            ordinal != null
              ? { fromId: edgeTarget.getAttribute('data-from'), toId: edgeTarget.getAttribute('data-to'), ordinal }
              : null;
        }
      }
      if (resolvedEdge && edgeTarget) {
        onEdgeClick({ kind: connectKind.kind, ...resolvedEdge, rect: edgeTarget.getBoundingClientRect() });
      }
    }
  }

  // Fullscreen: a CSS overlay covering the whole Custom UI panel is the
  // guaranteed baseline (position:fixed, no permissions needed). Real
  // browser Fullscreen API (taking over the whole screen, not just the
  // panel) is attempted on top of that as a best-effort upgrade — Forge
  // controls this iframe's embedding, not us, and whether Jira grants it
  // `allow="fullscreen"` isn't something this app can control or detect in
  // advance, so a rejected/unsupported requestFullscreen() is silently
  // ignored rather than treated as an error.
  function toggleFullscreen() {
    setFullscreen((prev) => {
      const next = !prev;
      if (next) {
        wrapRef.current?.requestFullscreen?.().catch(() => {});
      } else if (document.fullscreenElement) {
        document.exitFullscreen?.().catch(() => {});
      }
      return next;
    });
  }

  useEffect(() => {
    function onFullscreenChange() {
      setFullscreen(!!document.fullscreenElement && document.fullscreenElement === wrapRef.current);
    }
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => {
    if (!fullscreen) return undefined;
    function onKeyDown(e) {
      if (e.key === 'Escape') toggleFullscreen();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen]);

  // Escape cancels a pending click-click connect — same escape hatch as
  // the style popover (App.jsx) and fullscreen above.
  useEffect(() => {
    if (!pendingConnectFrom) return undefined;
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        setPendingConnectFrom(null);
        setPendingPointer(null);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pendingConnectFrom]);

  // The connect handle shown on idle hover (no gesture in progress yet) —
  // a single small dot at the node's bottom-right corner, not four
  // compass-point anchors like Miro/Figma: unlike those tools, Mermaid's
  // own layout engine decides where an edge actually attaches to a shape
  // regardless of which point you dragged from, so a single handle is all
  // this gesture needs (it's "connect this node to another," not "connect
  // from this specific side").
  function renderConnectHandle() {
    if (!connectable || !hoveredNode || activeConnectDrag || pendingConnectFrom) return null;
    const { rect } = hoveredNode;
    // The bounding-box *corner* (the original position here) is nowhere
    // near a diamond/decision node's actual outline — confirmed via a
    // jsdom scratch render of a real decision node's polygon points
    // (`15,0 30,-15 15,-30 0,-15`, relative to its own bounding box): a
    // diamond's vertices sit at each edge's *midpoint*, never at a corner,
    // so the corner is close to the single farthest point from the shape
    // for exactly this shape — a real "impossible to click" bug report,
    // not just a cosmetic nit. The right-edge midpoint, by contrast, sits
    // exactly on a diamond's rightmost vertex, and also lands on or right
    // at the visible edge for every other shape this palette offers
    // (rectangle, circle, hexagon, parallelogram, ...) since they're all
    // centered and symmetric top-to-bottom within their own bounding box.
    return (
      <div
        className="connect-handle"
        style={{ left: rect.right - 6, top: rect.top + rect.height / 2 - 6 }}
        title="Drag to another node to connect them, or click and then click another node"
        onPointerDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onConnectHandlePointerDown(e, hoveredNode.nodeId, rect);
        }}
      />
    );
  }

  // Highlights whatever node is currently under the pointer while a
  // connect gesture (drag or click-click) is active, as a "drop here"
  // affordance — but not the gesture's own source node, which would just
  // be confusing (it's already the thing being connected *from*).
  function renderConnectTarget() {
    const sourceId = activeConnectDrag?.fromNodeId ?? pendingConnectFrom?.nodeId;
    if (!sourceId || !hoveredNode || hoveredNode.nodeId === sourceId) return null;
    const { rect } = hoveredNode;
    return (
      <div
        className="connect-target-highlight"
        style={{ left: rect.left - 4, top: rect.top - 4, width: rect.width + 8, height: rect.height + 8 }}
      />
    );
  }

  // The live rubber-band line, screen-space (viewport pixels straight from
  // getBoundingClientRect()/clientX/clientY — no viewBox/zoom transform
  // needed, unlike the diagram's own pan/zoom, since this overlay isn't
  // part of the panned/zoomed SVG at all). pointer-events: none (styles.css)
  // is load-bearing here: without it, this element — not the node
  // underneath — is what document.elementFromPoint() would find on drop.
  function renderConnectLine() {
    const from = activeConnectDrag?.fromRect ?? pendingConnectFrom?.rect;
    const pointer = activeConnectDrag?.pointer ?? (pendingConnectFrom ? pendingPointer : null);
    if (!from || !pointer) return null;
    const x1 = from.left + from.width / 2;
    const y1 = from.top + from.height / 2;
    return (
      <svg className="connect-drag-line-overlay">
        <line x1={x1} y1={y1} x2={pointer.x} y2={pointer.y} />
      </svg>
    );
  }

  return (
    <div
      ref={wrapRef}
      className={`diagram-canvas-wrap${fullscreen ? ' diagram-canvas-wrap-fullscreen' : ''}`}
      // Keys the diagram's own surface (background) to its chosen Mermaid
      // theme, not Jira's light/dark chrome — see isDarkMermaidTheme.
      data-surface={isDarkMermaidTheme(theme) ? 'dark' : 'light'}
    >
      <div
        ref={containerRef}
        className={`diagram-canvas${isPanning ? ' diagram-canvas-panning' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={endDrag}
        onDoubleClick={onContainerDoubleClick}
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {renderConnectHandle()}
      {renderConnectTarget()}
      {renderConnectLine()}
      {/* One rounded pill instead of four separately-bordered buttons
          ([-][100%][+][⛶], per direct user request referencing Figma/Miro's
          zoom control) — the percent readout doubles as the reset button
          (title="Reset zoom"), so there's no separate ⤢ button anymore. */}
      <div className="diagram-zoom-controls">
        <button
          type="button"
          className="zoom-control-btn"
          title="Zoom out (or Ctrl+scroll)"
          onClick={() => zoomAt(1 / ZOOM_STEP)}
        >
          −
        </button>
        <button
          type="button"
          className="zoom-control-btn zoom-control-percent"
          title="Reset zoom"
          onClick={resetView}
        >
          {zoomPercent}%
        </button>
        <button
          type="button"
          className="zoom-control-btn"
          title="Zoom in (or Ctrl+scroll)"
          onClick={() => zoomAt(ZOOM_STEP)}
        >
          +
        </button>
        <div className="zoom-control-divider" />
        <button
          type="button"
          className="zoom-control-btn"
          title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          onClick={toggleFullscreen}
        >
          {fullscreen ? (
            <VidFullScreenOffIcon label="" size="small" />
          ) : (
            <VidFullScreenOnIcon label="" size="small" />
          )}
        </button>
      </div>
    </div>
  );
}
