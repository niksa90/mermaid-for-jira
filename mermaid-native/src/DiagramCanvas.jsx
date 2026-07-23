import React, { useEffect, useRef, useState } from 'react';
import { VidFullScreenOnIcon, VidFullScreenOffIcon } from './icons';
import { isDarkMermaidTheme } from './mermaid-renderer';
import { extractClickedNodeId } from './svg-node-id';

const ZOOM_STEP = 1.25;
const MIN_SCALE = 0.2;
const MAX_SCALE = 8;
// Below this much pointer movement (in screen px), a pointerdown/pointerup
// pair counts as a click on whatever was under it rather than a pan-drag —
// without this, any single-pixel jitter during a click (unavoidable with a
// mouse) would always read as "the user panned, not clicked" and the
// click-to-style popover (onNodeClick) would never fire.
const CLICK_MOVE_THRESHOLD = 6;

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
export default function DiagramCanvas({ svg, theme = 'default', onNodeClick, selectedNode }) {
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
    if (!dragRef.current || !svgElRef.current || !viewRef.current) return;
    const rect = svgElRef.current.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dx = e.clientX - dragRef.current.startClientX;
    const dy = e.clientY - dragRef.current.startClientY;
    if (Math.abs(dx) > CLICK_MOVE_THRESHOLD || Math.abs(dy) > CLICK_MOVE_THRESHOLD) {
      dragRef.current.moved = true;
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
    if (!onNodeClick || !downTarget?.closest) return;
    const target = downTarget.closest('.node[id]');
    if (!target) return;
    const resolved = extractClickedNodeId(target.getAttribute('id'));
    if (!resolved) return;
    onNodeClick({ ...resolved, rect: target.getBoundingClientRect() });
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
        onDoubleClick={resetView}
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: svg }}
      />
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
