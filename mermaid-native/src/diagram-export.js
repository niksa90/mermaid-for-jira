/**
 * Turns a live, rendered diagram <svg> element into downloadable files
 * (standalone SVG or rasterized PNG). Uses real browser DOM/canvas APIs
 * (Image, canvas, Blob/URL) — like mermaid-renderer.js's inlineSvgStyles()/
 * applyModernPolish(), this isn't unit tested under plain Node; verify by
 * actually downloading a file in a real browser after any change here.
 */

import { ensureXlinkNamespaceDeclared } from './mermaid-renderer.js';

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

  // Every node's `<g class="label">` wraps a couple of Mermaid-internal
  // bookkeeping <rect>s (an unclassed one and one with class="background")
  // left over from Mermaid's HTML-label code path — meaningless here since
  // this app forces htmlLabels:false everywhere, so neither ever carries a
  // width/height attribute (every *real* shape rect always has both).
  // inlineSvgStyles()'s ".node rect" class-rule pass and
  // applyModernPolish()'s node-rounding pass both match these placeholders
  // too, baking real fill/stroke/rx/filter onto them. Spec-compliant
  // renderers default the missing width/height to 0 and draw nothing either
  // way, so this is inert in Chrome and in librsvg — confirmed harmless,
  // not just untested — but ImageMagick on a box built `--without-rsvg`
  // (falling back to its own bundled MSVG coder) does not default them to
  // 0, so every node rendered as a solid, offset "ghost" duplicate there.
  // Cheap, safe hygiene to strip regardless of how common that specific
  // ImageMagick configuration actually is among users opening this file.
  clone.querySelectorAll('rect').forEach((el) => {
    if (!el.hasAttribute('width') && !el.hasAttribute('height')) {
      el.remove();
    }
  });

  // Mermaid splits a wrapped label's text into sibling `text-inner-tspan`
  // elements with no gap between the closing/opening tags
  // ("...only</tspan><tspan> history...") and relies on the *browser's*
  // default `xml:space` handling to keep a lone leading/trailing space
  // meaningful inside a tspan's text content. Confirmed via a real render
  // that librsvg (what gdk-pixbuf-based thumbnailers/viewers use, and a
  // reasonable stand-in for "most non-browser SVG viewers") trims that
  // space instead, silently joining adjacent words ("Language:English").
  // `xml:space="preserve"` on the root `<text>` inherits to every tspan
  // inside it and fixes this — confirmed with the same before/after
  // comparison, no effect on Chrome's rendering (which already preserved
  // the space by default).
  clone.querySelectorAll('text').forEach((el) => {
    el.setAttribute('xml:space', 'preserve');
  });

  // applyModernPolish() (mermaid-renderer.js) gives every node/actor shape a
  // drop shadow via a single `<feDropShadow>` filter primitive, and every
  // node rect/polygon references it. Confirmed via a real render (this
  // system's librsvg — via gdk-pixbuf-thumbnailer, the rendering path
  // GNOME's image viewers use — plus a user screenshot from GNOME's Loupe
  // showing the same result): when an SVG filter can't be applied, these
  // engines don't just drop the shadow effect, they render *nothing* for
  // the whole element referencing it — every node came out as floating
  // text with no box, fill, or border at all, confirmed by removing the
  // `filter` attribute and seeing the node reappear. `feDropShadow` is a
  // fairly recent shorthand (SVG Filter Effects Module) that this
  // installation's librsvg doesn't support; Chrome does, so the live in-app
  // preview (always a real browser) is unaffected — this is export-only,
  // like the font-family fix below. Rebuilt using the older, universally
  // supported filter-primitive combination (feGaussianBlur + feOffset +
  // feComponentTransfer for the opacity + feMerge) that produces the same
  // visual result — confirmed via the same real-render comparison, both in
  // a browser (unchanged) and under librsvg (now renders instead of
  // disappearing).
  clone.querySelectorAll('filter').forEach((filterEl) => {
    const dropShadow = filterEl.querySelector('feDropShadow');
    if (!dropShadow) return;
    const dx = dropShadow.getAttribute('dx') || '0';
    const dy = dropShadow.getAttribute('dy') || '0';
    const stdDeviation = dropShadow.getAttribute('stdDeviation') || '0';
    const floodOpacity = dropShadow.getAttribute('flood-opacity') || '1';
    const doc = filterEl.ownerDocument;
    const svgNs = 'http://www.w3.org/2000/svg';
    filterEl.removeChild(dropShadow);

    const blur = doc.createElementNS(svgNs, 'feGaussianBlur');
    blur.setAttribute('in', 'SourceAlpha');
    blur.setAttribute('stdDeviation', stdDeviation);
    blur.setAttribute('result', 'blur');

    const offset = doc.createElementNS(svgNs, 'feOffset');
    offset.setAttribute('in', 'blur');
    offset.setAttribute('dx', dx);
    offset.setAttribute('dy', dy);
    offset.setAttribute('result', 'offsetBlur');

    const transfer = doc.createElementNS(svgNs, 'feComponentTransfer');
    transfer.setAttribute('in', 'offsetBlur');
    transfer.setAttribute('result', 'shadow');
    const funcA = doc.createElementNS(svgNs, 'feFuncA');
    funcA.setAttribute('type', 'linear');
    funcA.setAttribute('slope', floodOpacity);
    transfer.appendChild(funcA);

    const merge = doc.createElementNS(svgNs, 'feMerge');
    const mergeShadow = doc.createElementNS(svgNs, 'feMergeNode');
    mergeShadow.setAttribute('in', 'shadow');
    const mergeSource = doc.createElementNS(svgNs, 'feMergeNode');
    mergeSource.setAttribute('in', 'SourceGraphic');
    merge.appendChild(mergeShadow);
    merge.appendChild(mergeSource);

    filterEl.appendChild(blur);
    filterEl.appendChild(offset);
    filterEl.appendChild(transfer);
    filterEl.appendChild(merge);
  });

  // Confirmed via a real render (headless Chrome vs. ImageMagick's SVG
  // delegate on the exact same file): Mermaid's/applyModernPolish()'s
  // font-family value — '"Inter", -apple-system, BlinkMacSystemFont,
  // "Segoe UI", Roboto, sans-serif', a CSS-style fallback stack with
  // embedded quoted multi-word names — renders fine in a real browser but
  // makes stricter/simpler SVG renderers (confirmed: ImageMagick's;
  // suspected of many non-browser viewers/thumbnailers) fail to parse the
  // attribute at all, which can blank out the *entire* element it's on
  // rather than just falling back to a default font. Fine for the live
  // in-app preview (always a real browser, under Forge's CSP, and "Inter"
  // is the deliberate brand font there — see mermaid-renderer.js), but an
  // exported file needs to survive being opened in whatever tool the user
  // has, not just a browser. Simplified to two plain, unquoted, comma-only
  // tokens for the export specifically: no visual regression in a real
  // browser either way, since a standalone file never has the actual Inter
  // webfont available to it regardless of how the fallback list is
  // written, so both versions already fall through to the same generic
  // sans-serif there.
  clone.querySelectorAll('[font-family]').forEach((el) => {
    el.setAttribute('font-family', 'Inter, sans-serif');
  });
  if (clone.hasAttribute('font-family')) {
    clone.setAttribute('font-family', 'Inter, sans-serif');
  }

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
  // This clone went through the same cloneNode(true) as the live element
  // mermaid-renderer.js already parsed/re-serialized once (in
  // inlineSvgStyles()/applyModernPolish()) — ensureXlinkNamespaceDeclared()
  // there exists precisely because that round trip can turn an <image>'s
  // `href` into an undeclared `xlink:href` (see its own comment for the
  // full story). This is a second, independent XMLSerializer call on that
  // same subtree, so it needs the identical repair — otherwise a diagram
  // whose live *preview* happens to render fine (HTML-parsed insertion
  // tolerates the missing declaration) could still export as an invalid
  // standalone SVG/PNG (a strict parser, or an <img> loading this file,
  // won't).
  const serialized = ensureXlinkNamespaceDeclared(new XMLSerializer().serializeToString(svgEl));
  return `<?xml version="1.0" encoding="UTF-8"?>\n${serialized}`;
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
