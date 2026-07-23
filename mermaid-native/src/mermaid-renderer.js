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

// Built-in Mermaid themes we expose as a per-diagram style choice, plus our
// own 'brand' preset (see BRAND_THEME_VARIABLES below). Excludes raw 'base':
// it's meant as a blank slate for custom themeVariables overrides and
// renders almost colorless on its own — picking it with no overrides would
// look broken, not like a style option. 'brand' is exactly "base plus the
// overrides that make it a real style", so it doesn't need a separate 'base'
// entry alongside it.
export const MERMAID_THEMES = ['default', 'neutral', 'forest', 'dark', 'brand'];

// A custom theme built on Mermaid's 'base' theme + themeVariables — the
// mechanism Mermaid itself provides for full customization — rather than a
// second named built-in theme. Colors are hand-picked to sit alongside this
// app's own chrome palette (styles.css's --color-primary/--color-text/
// --color-border), not read from Atlaskit design tokens: that path was
// already investigated once (see CLAUDE.md's "Atlaskit components and CSP"
// section) and confirmed no token stylesheet is loaded in this Custom UI
// iframe to read from.
//
// `fontFamily` must be a TOP-LEVEL key of the init directive below, not
// nested inside themeVariables — confirmed by rendering both ways with the
// real mermaid package (v11.16.0): nested, Mermaid silently keeps its
// hardcoded default font with no error, which would otherwise look like a
// config that "did nothing" with no signal as to why.
const BRAND_FONT_FAMILY =
  '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const BRAND_THEME_VARIABLES = {
  primaryColor: '#deebff',
  primaryBorderColor: '#0c66e4',
  primaryTextColor: '#172b4d',
  lineColor: '#6b778c',
  secondaryColor: '#e6fcff',
  secondaryBorderColor: '#00a3bf',
  tertiaryColor: '#eae6ff',
  tertiaryBorderColor: '#6554c0',
  noteBkgColor: '#fff7d6',
  noteBorderColor: '#ff991f',
  noteTextColor: '#172b4d',
  actorBkg: '#deebff',
  actorBorder: '#0c66e4',
  actorTextColor: '#172b4d',
  signalColor: '#44546f',
  signalTextColor: '#172b4d',
};
// NOTE (jsdom-verified, real mermaid v11.16.0): the actorBkg/actorBorder
// variables above are NOT confirmed to affect sequence-diagram actor boxes
// — Mermaid bakes their fill/stroke ("#eaeaea"/"#666") as literal SVG
// attributes directly, not through the <style> block's class rules, and
// that hardcoded pair came through unchanged under the 'base' theme with
// these overrides set. Flowchart node coloring (primaryColor/
// primaryBorderColor) IS confirmed working. Don't assume the 'brand' theme
// fully reskins sequence diagrams until this is re-checked in a real
// browser or against a different themeVariables key.

/**
 * Prepends a Mermaid init directive so a diagram can pick its own theme
 * without touching mermaid.initialize()'s global config — global re-init
 * would race between diagrams rendering concurrently on the same page.
 */
export function withTheme(source, theme) {
  const trimmed = (source || '').trim();
  if (!trimmed || !theme || theme === 'default') return trimmed;
  if (theme === 'brand') {
    const init = {
      theme: 'base',
      fontFamily: BRAND_FONT_FAMILY,
      themeVariables: BRAND_THEME_VARIABLES,
    };
    return `%%{init: ${JSON.stringify(init)}}%%\n${trimmed}`;
  }
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
    const wrapped = new Error(readableParseError(err));
    wrapped.line = extractErrorLine(err);
    throw wrapped;
  }
  const { svg } = await mermaid.render(id, trimmed);
  return applyModernPolish(inlineSvgStyles(svg), id);
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

// Temporary marker set by inlineSvgStyles() on any element that received an
// explicit per-node/state/entity `stroke-width` (the border-width picker
// control), so applyModernPolish() — which otherwise unconditionally bumps
// every node's stroke-width to a fixed value — knows to leave that element
// alone instead of clobbering the user's own choice. Stripped again inside
// applyModernPolish() once read, so it never leaks into the final SVG.
const EXPLICIT_STROKE_WIDTH_ATTR = 'data-mermaid-native-explicit-stroke-width';

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

    // Tracks which (element, attribute) pairs THIS function has itself
    // written, separate from el.hasAttribute() — Mermaid's raw SVG output
    // already carries baseline fill/stroke on some elements before we ever
    // touch them (confirmed: sequence-diagram actor <rect>s always come out
    // as fill="#eaeaea" stroke="#666", regardless of theme — Mermaid's own
    // markup, not a per-element override). The original version of this
    // function treated "already has the attribute" as "an intentional
    // per-element override, leave it alone," which silently discarded the
    // theme's own `.actor{fill:...}` class rule for every theme including
    // Mermaid's built-in ones — confirmed via real-browser testing where
    // actor boxes stayed the exact same light gray no matter which theme
    // was selected. Gating on "did WE already write this" instead of "does
    // it already exist" fixes that while preserving the original intent:
    // a later, less-specific non-important rule still can't clobber a
    // value an earlier rule in this same pass already set for the same
    // element/attribute (this is what the !important two-pass logic below
    // was already built around).
    const writtenByUs = new WeakMap();
    function alreadyWrittenByUs(el, attr) {
      return writtenByUs.get(el)?.has(attr) ?? false;
    }
    function markWritten(el, attr) {
      if (!writtenByUs.has(el)) writtenByUs.set(el, new Set());
      writtenByUs.get(el).add(attr);
    }

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
            if (forceOverwrite || !alreadyWrittenByUs(el, attr)) {
              el.setAttribute(attr, value);
              markWritten(el, attr);
              // Only the !important pass (forceOverwrite) represents a real
              // per-element classDef/class override winning the cascade —
              // the normal (non-important) pass is just the theme's own
              // generic `.node rect{stroke-width:1px}` baseline rule, which
              // applyModernPolish() is supposed to keep bumping to its
              // fixed value. Marking there too would mark every node in
              // every diagram and defeat that bump entirely.
              if (forceOverwrite && attr === 'stroke-width') {
                el.setAttribute(EXPLICIT_STROKE_WIDTH_ATTR, '1');
              }
            }
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
        if (attr) {
          el.setAttribute(attr, value);
          // Always a genuine per-element override (this whole pass only
          // exists for per-node style="..." directives) — see
          // EXPLICIT_STROKE_WIDTH_ATTR above.
          if (attr === 'stroke-width') el.setAttribute(EXPLICIT_STROKE_WIDTH_ATTR, '1');
        }
      });
      el.removeAttribute('style');
    });

    return new XMLSerializer().serializeToString(svgEl);
  } catch {
    return svgString;
  }
}

/**
 * Rounds node/actor corners, gives edges a heavier stroke, and adds a
 * subtle drop shadow to node shapes — Mermaid's default shapes otherwise
 * render sharp-cornered with a 1px hairline stroke and no depth, which
 * reads as dated next to Jira's own rounded, "card-like" UI chrome. An
 * earlier version of this used a smaller rx (6) and stroke-width (1.5)
 * with no shadow at all — too subtle a delta to register as "different"
 * at a glance, per direct user feedback, so both were increased and a
 * shadow was added specifically to make the change legible without
 * requiring the viewer to pick a non-default theme first.
 *
 * Applied as real SVG presentation attributes/elements (rx/ry/
 * stroke-width/filter), the same mechanism inlineSvgStyles() uses for
 * colors — not CSS, so it isn't blocked by Forge's CSP and doesn't need
 * STYLE_PROPS_TO_ATTRS extended. Runs after inlineSvgStyles() so it only
 * ever adjusts attributes already baked onto the final elements, never
 * competes with the <style>-block cascade pass above.
 *
 * Selectors target Mermaid's own class names, confirmed against the real
 * v11.16.0 output: node shapes sit inside a wrapping `<g class="node">` (the
 * class isn't on the shape itself, hence the descendant selector), while
 * sequence-diagram actor boxes carry `class="actor ..."` directly. Applies
 * uniformly regardless of the diagram's chosen color theme — this is a
 * shape/weight change, not a color one. Every selector here degrades safely
 * if it matches nothing (e.g. a diagram type with different class names),
 * so this is best-effort polish, not a correctness-critical pass; verify
 * visually across diagram types after changing these selectors.
 *
 * `idPrefix` (the same per-diagram id renderMermaid already generates via
 * safeDiagramId) namespaces the injected <filter> id — multiple diagrams
 * can be on the same page at once, each with its own SVG root, and a bare
 * "modern-shadow" id would collide across them.
 */
function applyModernPolish(svgString, idPrefix) {
  try {
    const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
    const svgEl = doc.documentElement;
    if (!svgEl || svgEl.nodeName === 'parsererror') return svgString;
    const svgNs = 'http://www.w3.org/2000/svg';

    const filterId = `${idPrefix}-modern-shadow`;
    const filter = doc.createElementNS(svgNs, 'filter');
    filter.setAttribute('id', filterId);
    filter.setAttribute('x', '-30%');
    filter.setAttribute('y', '-30%');
    filter.setAttribute('width', '160%');
    filter.setAttribute('height', '160%');
    const feDropShadow = doc.createElementNS(svgNs, 'feDropShadow');
    feDropShadow.setAttribute('dx', '0');
    feDropShadow.setAttribute('dy', '1');
    feDropShadow.setAttribute('stdDeviation', '1.5');
    feDropShadow.setAttribute('flood-opacity', '0.18');
    filter.appendChild(feDropShadow);
    let defs = svgEl.querySelector('defs');
    if (!defs) {
      defs = doc.createElementNS(svgNs, 'defs');
      svgEl.insertBefore(defs, svgEl.firstChild);
    }
    defs.appendChild(filter);

    doc.querySelectorAll('.node rect, .node polygon, .actor').forEach((el) => {
      if (el.tagName.toLowerCase() === 'rect' && !el.hasAttribute('rx')) {
        el.setAttribute('rx', '8');
        el.setAttribute('ry', '8');
      }
      if (!el.hasAttribute('filter')) {
        el.setAttribute('filter', `url(#${filterId})`);
      }
      // Fatter borders, per direct user feedback comparing against a
      // reference screenshot — Mermaid's own theme stroke-width (usually
      // 1px) reads as flimsy. Bumped a second time (2 -> 3) per further
      // feedback that 2 still wasn't enough of a delta. Overwrites
      // unconditionally (not gated on !hasAttribute like rx/filter above):
      // every node already carries SOME stroke-width from the theme's
      // <style> block by this point, so "already has the attribute" is
      // guaranteed true and would otherwise always skip this.
      //
      // Exception: a node the per-node border-width picker explicitly set
      // (EXPLICIT_STROKE_WIDTH_ATTR, written by inlineSvgStyles() above) —
      // that's a real user choice, not a theme default, and this bump would
      // otherwise silently overwrite it back to 3 on every render. Verified
      // via jsdom against both flowchart's inline-style-attribute path and
      // state diagrams' !important classDef path that only genuine
      // per-element overrides carry this marker, never the theme's own
      // generic (non-important) `.node rect{stroke-width:1px}` rule.
      if (el.hasAttribute(EXPLICIT_STROKE_WIDTH_ATTR)) {
        el.removeAttribute(EXPLICIT_STROKE_WIDTH_ATTR);
      } else {
        el.setAttribute('stroke-width', '3');
      }
    });

    // Universal modern font + slightly heavier weight, applied regardless
    // of the diagram's chosen color theme (unlike BRAND_FONT_FAMILY in
    // withTheme(), which only applies under the 'brand' theme) — per
    // direct user feedback that text needed to "stand out more" across the
    // board, not just on the one custom theme. @fontsource/inter is
    // already loaded unconditionally (see App.jsx), so this is just
    // pointing existing text at the font that's already available. Runs
    // after inlineSvgStyles(), so it overwrites whatever font-family that
    // pass baked in from the theme's own <style> block.
    doc.querySelectorAll('text, tspan').forEach((el) => {
      el.setAttribute(
        'font-family',
        '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
      );
      el.setAttribute('font-weight', '500');
    });

    // .transition is stateDiagram-v2's edge class (confirmed against real
    // v11.16.0 output — state diagrams don't reuse flowchart's .edgePath/
    // .flowchart-link at all, a different mechanism from the shared node/
    // actor rounding above).
    doc
      .querySelectorAll(
        '.flowchart-link, .edgePath path, .messageLine0, .messageLine1, .transition'
      )
      .forEach((el) => {
        el.setAttribute('stroke-width', '2');
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

// Extracts the 1-based source line a Mermaid parse error points at, so the
// editor can highlight exactly the offending line instead of just showing a
// flattened error string. Mermaid's jison-generated parsers (shared across
// the flowchart/state/sequence/... grammars) format this consistently as
// "Parse error on line N:" in err.message — confirmed against the real
// mermaid package (v11.16.0) via a jsdom scratch render for flowchart,
// state, and sequence syntax errors, not assumed from docs. Falls back to
// null (no highlight, same "silent no-op for unsupported cases" convention
// as the rest of this file) for any error shape that doesn't match rather
// than guessing a line.
export function extractErrorLine(err) {
  const raw = err?.str || err?.message || String(err);
  const match = raw.match(/on line (\d+)/i);
  return match ? Number(match[1]) : null;
}

export function safeDiagramId(prefix, index) {
  // Mermaid internally does `querySelector('#' + id)` while rendering.
  // CSS identifiers can't start with a digit, and diagram.id is derived from
  // Date.now(), so this must always start with a letter or the render
  // crashes with "is not a valid selector" instead of showing the diagram.
  return `d-${prefix}-${index}-${Math.random().toString(36).slice(2, 8)}`;
}
