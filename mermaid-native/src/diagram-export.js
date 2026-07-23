/**
 * Turns a live, rendered diagram <svg> element into downloadable files
 * (standalone SVG or rasterized PNG). Uses real browser DOM/canvas APIs
 * (Image, canvas, Blob/URL) — like mermaid-renderer.js's inlineSvgStyles()/
 * applyModernPolish(), this isn't unit tested under plain Node; verify by
 * actually downloading a file in a real browser after any change here.
 */

// Matches .diagram-canvas-wrap[data-surface] in styles.css — the exported
// file's background should match what the user actually sees on screen
// (a diagram's surface follows its own Mermaid theme, not Jira's chrome —
// see isDarkMermaidTheme), not a bare white/transparent canvas.
export const EXPORT_SURFACE_COLOR = { light: '#fafbfc', dark: '#22272b' };

/**
 * Clones the live SVG element into a standalone, natural-size document:
 * resets viewBox/width/height to the diagram's full natural bounds
 * (ignoring whatever pan/zoom the user currently has applied on screen —
 * an export should always capture the whole diagram, not the current
 * viewport), strips this app's own click-hit-area helper paths
 * (DiagramCanvas.jsx's invisible fat-stroke edge clones, identifiable by
 * their own stroke="transparent") and node-selection highlight class (both
 * meaningless outside the live, interactive canvas), and paints in a
 * background rect so the file isn't transparent wherever Mermaid didn't
 * draw a shape.
 */
export function buildExportSvgElement(liveSvgEl, natural, dark) {
  const clone = liveSvgEl.cloneNode(true);
  // Matched by DiagramCanvas.jsx's own data-hit-clone marker (the same one
  // its widened-hit-area effect uses to avoid re-cloning an edge it already
  // widened), not a style-based selector like `[stroke="transparent"]` — a
  // real Mermaid-drawn element could legitimately use a transparent stroke,
  // and matching on that would silently delete it from the export too.
  clone.querySelectorAll('[data-hit-clone]').forEach((el) => el.remove());
  clone.querySelectorAll('.node-style-selected').forEach((el) => el.classList.remove('node-style-selected'));

  const { minX, minY, width, height } = natural;
  clone.setAttribute('viewBox', `${minX} ${minY} ${width} ${height}`);
  clone.setAttribute('width', String(Math.round(width)));
  clone.setAttribute('height', String(Math.round(height)));
  // No manual xmlns/xmlns:xlink setAttribute() here: `clone` already carries
  // the correct SVG namespace from its original DOMParser('image/svg+xml')
  // parse in mermaid-renderer.js, and XMLSerializer emits the right xmlns
  // declarations for whatever namespaces the subtree actually uses when it
  // serializes a standalone root element. Setting a plain "xmlns" attribute
  // by hand doesn't carry namespace semantics the way the serializer's own
  // declaration does, and risks emitting it twice on the same element —
  // which would make the browser refuse to parse the resulting file/image.

  const svgNs = 'http://www.w3.org/2000/svg';
  const bg = clone.ownerDocument.createElementNS(svgNs, 'rect');
  bg.setAttribute('x', String(minX));
  bg.setAttribute('y', String(minY));
  bg.setAttribute('width', String(width));
  bg.setAttribute('height', String(height));
  bg.setAttribute('fill', dark ? EXPORT_SURFACE_COLOR.dark : EXPORT_SURFACE_COLOR.light);
  clone.insertBefore(bg, clone.firstChild);

  return clone;
}

export function serializeExportSvg(svgEl) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(svgEl)}`;
}

/**
 * Triggers a browser file download for an already-built Blob. A plain,
 * momentarily-appended <a download> is the standard vanilla-JS technique —
 * no library needed, and this only runs once per user click (not hot-path
 * code that would need to reuse a cached anchor).
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on a delay, not immediately: revoking synchronously has been
  // known to drop the download in some browsers (historically Safari)
  // before the click has actually been dispatched/handled.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Rasterizes an SVG string to a PNG Blob via an offscreen <canvas> — the
 * standard technique (Image + drawImage + canvas.toBlob), the same one
 * e.g. mermaid.live's own "download PNG" action uses. `scale` renders at a
 * multiple of the SVG's natural size (2x here) so the exported file
 * doesn't look soft when viewed/printed larger than its on-screen size.
 *
 * Known limitation, not worked around: this app's diagrams set
 * font-family to "Inter" (a bundled webfont — see mermaid-renderer.js's
 * applyModernPolish()), but a browser's offscreen <img>/canvas rendering
 * of an SVG doesn't inherit fonts the *host page* has loaded — only fonts
 * embedded inside the SVG itself (a data-URI @font-face) or actually
 * installed as a system font. The exported PNG's text falls back to the
 * next name in that font-family's own list (a native system UI font), not
 * silently breaks — same "real but purely cosmetic gap" category as the
 * unhandled CSS properties documented in mermaid-renderer.js. Confirm this
 * visually before deciding it needs fixing; if it does, the fix is
 * embedding the font as a base64 data URI inside a <style> in this
 * export-only SVG string (never the live DOM one, which stays subject to
 * Forge's CSP — see CLAUDE.md's CSP section for why a <style> block can't
 * go through there).
 */
export function svgStringToPngBlob(svgString, width, height, scale = 2) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((pngBlob) => {
        if (pngBlob) resolve(pngBlob);
        else reject(new Error('Could not create PNG image.'));
      }, 'image/png');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not rasterize diagram to PNG.'));
    };
    img.src = url;
  });
}

/** Turns a diagram's own label (or lack of one) into a safe file basename
 * (no extension) — used so a downloaded file reads as e.g.
 * "deployment-flow.png" rather than an opaque diagram id. */
export function slugifyFilename(text) {
  const slug = (text || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'diagram';
}
