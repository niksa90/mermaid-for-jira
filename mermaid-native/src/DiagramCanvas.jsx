import React, { useEffect, useRef, useState } from 'react';
import VidFullScreenOnIcon from '@atlaskit/icon/glyph/vid-full-screen-on';
import VidFullScreenOffIcon from '@atlaskit/icon/glyph/vid-full-screen-off';
import { isDarkMermaidTheme } from './mermaid-renderer';

const ZOOM_STEP = 1.25;
const MIN_SCALE = 0.2;
const MAX_SCALE = 8;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Wraps a rendered Mermaid SVG string with wheel-zoom, drag-to-pan, and
 * +/-/reset controls.
 *
 * Pan/zoom is implemented by rewriting the SVG's own `viewBox` attribute,
 * not a CSS `transform`/inline `style` — Forge Custom UI's CSP blocks
 * inline style attributes (the reason `mermaid-renderer.js` bakes colors
 * into presentation attributes instead of a <style> block). viewBox is a
 * plain SVG attribute, so it isn't affected.
 */
export default function DiagramCanvas({ svg, theme = 'default' }) {
  const wrapRef = useRef(null);
  const containerRef = useRef(null);
  const svgElRef = useRef(null);
  const baseViewBoxRef = useRef(null); // natural {minX, minY, width, height}
  const viewRef = useRef(null); // current {minX, minY, width, height}
  const dragRef = useRef(null);
  const [isPanning, setIsPanning] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

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
  }, [svg]);

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
  }

  function resetView() {
    if (!baseViewBoxRef.current) return;
    viewRef.current = { ...baseViewBoxRef.current };
    applyView();
  }

  // Attached manually (not React's onWheel): React treats wheel listeners
  // as passive by default, which silently no-ops preventDefault() and lets
  // the page scroll instead of zooming.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    function onWheel(e) {
      if (!viewRef.current) return;
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
    };
    setIsPanning(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e) {
    if (!dragRef.current || !svgElRef.current || !viewRef.current) return;
    const rect = svgElRef.current.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const v = viewRef.current;
    const dxUnits = ((e.clientX - dragRef.current.startClientX) / rect.width) * v.width;
    const dyUnits = ((e.clientY - dragRef.current.startClientY) / rect.height) * v.height;
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
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        onDoubleClick={resetView}
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <div className="diagram-zoom-controls">
        <button
          type="button"
          className="btn btn-subtle btn-icon"
          title="Zoom out"
          onClick={() => zoomAt(1 / ZOOM_STEP)}
        >
          −
        </button>
        <button type="button" className="btn btn-subtle btn-icon" title="Reset zoom" onClick={resetView}>
          ⤢
        </button>
        <button
          type="button"
          className="btn btn-subtle btn-icon"
          title="Zoom in"
          onClick={() => zoomAt(ZOOM_STEP)}
        >
          +
        </button>
        <button
          type="button"
          className="btn btn-subtle btn-icon"
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
