---
name: mermaid-diagram-styling
description: Add or extend diagram styling/theming options (theme picker, per-node colors, fonts, etc.) in the mermaid-native Forge app. Use whenever a change touches how diagrams look, not just what they contain — grounds the work in the Forge CSP constraint that silently strips most CSS-based Mermaid theming.
---

# Adding a diagram styling option

Forge Custom UI's CSP blocks inline `<style>` tags and `style="..."`
attributes. Mermaid's normal theming (including most of `themeVariables`)
relies on both, so styling changes need to go through the workaround already
in `mermaid-native/src/mermaid-renderer.js` rather than around it.

## How rendering currently survives the CSP

1. `mermaid.initialize()` is called with `htmlLabels: false` everywhere, so
   Mermaid emits plain SVG `<text>` instead of HTML-in-`foreignObject`
   labels (which the CSP would block from being styled at all).
2. `renderMermaid()` calls `mermaid.render()`, which still emits a `<style>`
   block with CSS rules — this block would normally do nothing under Forge's
   CSP.
3. `inlineSvgStyles()` parses that `<style>` block and, for each rule, copies
   over only the CSS properties present in `STYLE_PROPS_TO_ATTRS` (`fill`,
   `stroke`, `stroke-width`, `stroke-dasharray`, `opacity`, `color`,
   `font-family`, `font-size`, `font-weight`, `text-anchor`) as SVG
   presentation attributes on the matching elements. The `<style>` block is
   then deleted.

**Anything not in that whitelist is silently dropped with no error** — a
theme or color that "should" work per Mermaid's docs can render as default
black/unstyled with nothing in the console to explain why.

## Workflow for a new styling capability

1. **Identify what CSS properties the feature needs.** E.g. a "rounded vs.
   sharp corners" toggle likely needs `rx`/`ry` (not currently in the
   whitelist, and not a plain CSS-to-attribute copy — check whether Mermaid
   expresses this as CSS at all before assuming this approach works).
2. **Check whether those properties are already in `STYLE_PROPS_TO_ATTRS`.**
   If yes, the feature likely works today — just needs UI to let the user
   pick a value that maps to Mermaid `theme`/`themeVariables` config passed
   into `mermaid.initialize()` or a per-render override.
3. **If not, extend `STYLE_PROPS_TO_ATTRS`** with the new CSS property → SVG
   attribute pair, only if that CSS property has a direct 1:1 SVG
   presentation-attribute equivalent (most fill/stroke/text properties do;
   layout properties like `padding`/`margin` do not and need a different
   approach entirely).
4. **Never assume — render and inspect the actual SVG output** after the
   change (deploy + open the panel in a real browser, or drive it via
   Playwright/devtools). Confirm the target elements actually carry the new
   attribute. This is the only reliable signal; Mermaid's theming docs
   describe browser behavior, not Forge-CSP-constrained behavior.
5. **Persist style choices the same way diagram source is persisted** — as
   part of the diagram object saved via `setFieldValue` (see `App.jsx`'s
   `updateDiagram`/`persist`), so a per-diagram style choice (not just a
   global one) survives reloads. Don't introduce a separate storage
   mechanism for style state.
6. If the new capability is global rather than per-diagram (e.g. an
   organization-wide default theme), keep it inside the same Jira issue
   entity property or a second one under the same `PROPERTY_KEY` pattern in
   `resolvers/index.js` — don't reach for Forge KVS storage (`storage:app`)
   for this; see the $0-cost constraint in `CLAUDE.md`.
