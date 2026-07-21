let initialized = false;
let mermaidPromise = null;

/** Lazily loads mermaid.js so it isn't in the main bundle — most issue views
 * and field renders don't need it at all, and it's the single biggest
 * dependency in this app. */
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import(/* webpackChunkName: "mermaid" */ 'mermaid').then(
      (mod) => mod.default
    );
  }
  return mermaidPromise;
}

async function ensureInit() {
  const mermaid = await loadMermaid();
  if (!initialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'default',
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      // Forge Custom UI's CSP blocks inline <style> tags, which is how
      // Mermaid normally colors/positions HTML-based labels. Forcing plain
      // SVG <text> labels lets inlineSvgStyles() bake colors/fonts in as
      // presentation attributes instead, so text actually renders styled.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      class: { htmlLabels: false },
      state: { htmlLabels: false },
    });
    initialized = true;
  }
  return mermaid;
}

// Built-in Mermaid themes we expose as a per-diagram style choice.
// Excludes 'base': it's meant as a blank slate for custom themeVariables
// overrides (not supported yet) and renders almost colorless on its own —
// picking it with no overrides would look broken, not like a style option.
export const MERMAID_THEMES = ['default', 'neutral', 'forest', 'dark'];

/**
 * Prepends a Mermaid init directive so a diagram can pick its own theme
 * without touching mermaid.initialize()'s global config — global re-init
 * would race between diagrams rendering concurrently on the same page.
 */
export function withTheme(source, theme) {
  const trimmed = (source || '').trim();
  if (!trimmed || !theme || theme === 'default') return trimmed;
  return `%%{init: {"theme": "${theme}"}}%%\n${trimmed}`;
}

/**
 * Whether a diagram's chosen Mermaid theme renders on a dark canvas
 * ('dark' is the only one of MERMAID_THEMES that does). Used to give the
 * diagram's own surface (preview pane, fullscreen backdrop) a matching
 * light/dark background — independent of Jira's own light/dark chrome —
 * so diagram text stays legible against its immediate backdrop regardless
 * of which theme the diagram's author picked.
 */
export function isDarkMermaidTheme(theme) {
  return theme === 'dark';
}

/**
 * Renders Mermaid source to an SVG string. Throws with a readable message on
 * parse/syntax errors so callers can show an inline error instead of a blank
 * panel.
 */
export async function renderMermaid(id, source) {
  const mermaid = await ensureInit();
  const trimmed = (source || '').trim();
  if (!trimmed) {
    throw new Error('Diagram is empty.');
  }
  try {
    await mermaid.parse(trimmed);
  } catch (err) {
    throw new Error(readableParseError(err));
  }
  const { svg } = await mermaid.render(id, trimmed);
  return inlineSvgStyles(svg);
}

// CSS properties that have a direct SVG presentation-attribute equivalent.
// Forge Custom UI's CSP blocks inline <style> tags/attributes, so Mermaid's
// theme (colors, fonts, strokes) would otherwise be silently dropped and
// every shape would render with the browser's unstyled black default fill.
// Presentation attributes (fill=, stroke=, ...) are plain SVG/XML attributes,
// not CSS, so they render fine even when style-src is locked down.
const STYLE_PROPS_TO_ATTRS = {
  fill: 'fill',
  stroke: 'stroke',
  'stroke-width': 'stroke-width',
  'stroke-dasharray': 'stroke-dasharray',
  opacity: 'opacity',
  color: 'color',
  'font-family': 'font-family',
  'font-size': 'font-size',
  'font-weight': 'font-weight',
  'text-anchor': 'text-anchor',
  // display/visibility/dominant-baseline: needed once treemap-beta support
  // landed (Mermaid 11). Treemap emits some label/header elements with
  // `style="display: none;"` to hide overflow/duplicate variants it doesn't
  // end up using — without converting this, the style attribute is just
  // dropped and those elements render visible, duplicating labels.
  display: 'display',
  visibility: 'visibility',
  'dominant-baseline': 'dominant-baseline',
};

export function parseInlineStyleAttr(styleAttr) {
  const declarations = {};
  (styleAttr || '').split(';').forEach((decl) => {
    const i = decl.indexOf(':');
    if (i === -1) return;
    const prop = decl.slice(0, i).trim();
    // Strip a trailing !important the same way the <style>-block class-rule
    // pass already does (see below) — Mermaid 11's per-node `style
    // NodeId fill:...` output started appending `!important` to every
    // declaration (Mermaid 10 didn't), and left in, it becomes part of the
    // SVG attribute value ("fill=\"#f00 !important\""), which is invalid
    // syntax there and silently fails to apply instead of showing the
    // requested color.
    const value = decl.slice(i + 1).trim().replace(/\s*!important\s*$/i, '');
    if (prop && value) declarations[prop] = value;
  });
  return declarations;
}

/**
 * Bakes the CSS rules from a Mermaid SVG's embedded <style> block, and any
 * per-element inline `style="..."` attributes, into presentation attributes
 * on the matching elements, then drops both. Returns the original SVG
 * unchanged if parsing fails for any reason (e.g. unsupported browser API),
 * so this is purely additive.
 *
 * Both sources exist in Mermaid's output: theme colors go through the
 * <style> block's class rules, but per-node `style NodeId fill:#...`
 * directives (see mermaid-native/CLAUDE.md) are written as a `style="..."`
 * attribute directly on that node — a completely separate code path that
 * needs its own conversion, or custom node colors silently render as
 * whatever the theme default is instead of what was actually requested.
 */
function inlineSvgStyles(svgString) {
  try {
    const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
    const svgEl = doc.documentElement;
    if (!svgEl || svgEl.nodeName === 'parsererror') return svgString;

    function applyToSelector(selectorText, declarations, forceOverwrite) {
      for (const selector of selectorText.split(',')) {
        let matches;
        try {
          matches = doc.querySelectorAll(selector.trim());
        } catch {
          continue; // skip selectors the fragment can't evaluate (e.g. :root)
        }
        matches.forEach((el) => {
          declarations.forEach(([attr, value]) => {
            // Don't clobber an attribute the diagram itself set intentionally
            // (unless this declaration is !important — see below).
            if (forceOverwrite || !el.hasAttribute(attr)) el.setAttribute(attr, value);
          });
        });
      }
    }

    const styleEls = Array.from(doc.querySelectorAll('style'));
    if (styleEls.length > 0) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(styleEls.map((el) => el.textContent).join('\n'));

      // !important rules are deferred to a second pass that always
      // overwrites, applied after every normal rule — matching real CSS
      // cascade semantics where !important wins regardless of source order
      // or specificity. This matters concretely for classDef/class-based
      // per-state coloring (state-style.js): Mermaid always emits that as
      // !important precisely so it beats the base theme's own generic
      // node/shape rules, which appear earlier in the stylesheet and would
      // otherwise claim `fill`/`stroke` first under a plain first-write-wins
      // scan, silently discarding the override.
      const importantRules = [];

      for (const rule of sheet.cssRules) {
        if (!rule.selectorText) continue;
        const declarations = [];
        const importantDeclarations = [];
        for (const prop of rule.style) {
          const attr = STYLE_PROPS_TO_ATTRS[prop];
          if (!attr) continue;
          // Defensive: some CSSOM implementations return the literal
          // "!important" suffix as part of getPropertyValue()'s result
          // rather than stripping it (getPropertyPriority() is supposed to
          // be the only place it surfaces) — left in, it'd become part of
          // an SVG attribute value, which isn't valid syntax there and
          // would render as a broken/default fill instead of the color
          // that was actually requested.
          const value = rule.style.getPropertyValue(prop).replace(/\s*!important\s*$/i, '');
          if (rule.style.getPropertyPriority(prop) === 'important') {
            importantDeclarations.push([attr, value]);
          } else {
            declarations.push([attr, value]);
          }
        }
        if (declarations.length > 0) applyToSelector(rule.selectorText, declarations, false);
        if (importantDeclarations.length > 0) {
          importantRules.push([rule.selectorText, importantDeclarations]);
        }
      }

      importantRules.forEach(([selectorText, importantDeclarations]) => {
        applyToSelector(selectorText, importantDeclarations, true);
      });

      styleEls.forEach((el) => el.remove());
    }

    // Per-node `style NodeId fill:#...` directives, applied second and
    // unconditionally (unlike the class rules above) so they win over theme
    // colors — matching normal CSS cascade behavior, where an inline style
    // attribute always beats a class selector.
    doc.querySelectorAll('[style]').forEach((el) => {
      const declarations = parseInlineStyleAttr(el.getAttribute('style'));
      Object.entries(declarations).forEach(([prop, value]) => {
        const attr = STYLE_PROPS_TO_ATTRS[prop];
        if (attr) el.setAttribute(attr, value);
      });
      el.removeAttribute('style');
    });

    return new XMLSerializer().serializeToString(svgEl);
  } catch {
    return svgString;
  }
}

export function readableParseError(err) {
  const raw = err?.str || err?.message || String(err);
  return raw
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export function safeDiagramId(prefix, index) {
  // Mermaid internally does `querySelector('#' + id)` while rendering.
  // CSS identifiers can't start with a digit, and diagram.id is derived from
  // Date.now(), so this must always start with a letter or the render
  // crashes with "is not a valid selector" instead of showing the diagram.
  return `d-${prefix}-${index}-${Math.random().toString(36).slice(2, 8)}`;
}
