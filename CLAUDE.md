# Mermaid for Jira — project context

A Jira Forge app (Custom UI) that lets users attach one or more editable Mermaid
diagrams to a Jira issue via an issue panel. Proof-of-concept stage: functional,
rough around the edges (see "Known state" below).

The actual app lives in `mermaid-native/` (its own `package.json`/`manifest.yml`).
The workspace root only adds `.env` (Forge/Atlassian test-site credentials —
never print or commit its contents) and `.playwright-mcp/` (artifacts from past
browser-based verification sessions).

## Non-negotiable constraint: $0/month

This is the hard requirement behind every architectural choice here — flag
anything that risks it before writing code, don't just implement it:

- No external services, no paid APIs, no Forge premium/paid tier usage. Stay
  inside Atlassian's free Forge developer offering and Jira Cloud's included
  REST APIs.
- Diagram data is stored as a **Jira issue entity property**
  (`PUT`/`GET /rest/api/3/issue/{key}/properties/mermaid-diagram-board`, see
  `mermaid-native/src/resolvers/index.js`) — deliberately **not** Forge's own
  KVS (`@forge/api`'s `storage.set/get`, the `storage:app` scope). Entity
  properties ride on Jira's own data, not a separately billed Forge storage
  bucket. Don't switch storage backends without re-confirming this reasoning
  still holds against current Atlassian docs. (The `storage:app` scope was
  removed from `manifest.yml` since it was never actually used.)
- Mermaid renders entirely client-side inside the Custom UI iframe — no
  server-side rendering, no external diagram-rendering service.
- Don't treat any specific Forge free-tier quota number as fixed knowledge —
  Atlassian's billing model shifts over time. If a limit actually matters,
  check current docs rather than assuming.
- **GB-seconds (Forge function compute) are spent only by resolver
  invocations** — the static Custom UI bundle, React, and Mermaid rendering
  all run client-side in the browser and cost nothing against that budget.
  When optimizing for GB-seconds, look at what triggers `invoke('getFieldValue'
  | 'setFieldValue', ...)`, not bundle size (that's a load-time concern
  instead). This is why edit/display mode is deliberately kept as client-only
  React state (`modes` in `App.jsx`), not part of the persisted diagram
  object — toggling it used to fire a resolver invocation on every click for
  no content change. To check actual usage, use the Forge developer console's
  usage metrics for this app — don't estimate or fabricate a GB-seconds
  figure from the code.

## Architecture

- `mermaid-native/manifest.yml` — one `jira:issuePanel` module ("Mermaid
  Diagrams"), Custom UI, backed by one resolver function.
- `mermaid-native/src/resolvers/index.js` — backend resolver
  (`getFieldValue` / `setFieldValue`), calls Jira REST `asUser()`. Beyond a
  plain read/write, it implements:
  - **Optimistic concurrency**: `getFieldValue` returns a `snapshot`
    (`stableStringify`d — see `mermaid-native/src/stable-json.js`) of what's
    currently stored, alongside `diagrams`. The client sends that snapshot
    back as `baseSnapshot` on every `setFieldValue` call; the resolver
    re-reads the current server value and compares its own `stableStringify`
    of it to `baseSnapshot` before writing. **Use `stableStringify`, never
    plain `JSON.stringify`, for anything that becomes or is compared against
    a snapshot** — Jira's entity-property store isn't guaranteed to
    round-trip key order/formatting byte-for-byte, and raw string comparison
    would misfire as a false "someone else changed this" conflict on
    perfectly ordinary sequential saves by the same user. A mismatch means
    someone else changed the issue's diagrams in between — the resolver
    returns `{ conflict: true, current }` instead of silently overwriting,
    and the client surfaces a "someone else changed these diagrams" banner
    (see `App.jsx`'s `conflict` state) rather than clobbering their edit.
    Pass `force: true` to skip the check and write anyway (used by the "keep my
    changes" conflict-resolution path). Don't strip `baseSnapshot` handling
    out to "simplify" a future save-path change — that's exactly what
    reintroduces silent last-write-wins.
  - **Size-limit enforcement**: rejects (throws) if the serialized value
    would exceed Jira's documented 32,768-byte entity-property limit
    (https://developer.atlassian.com/cloud/jira/platform/jira-entity-properties/).
    `App.jsx` also checks this client-side before attempting a save, purely
    to fail fast and avoid a doomed resolver invocation — the resolver check
    is the actual enforcement and must stay even if the client-side one ever
    changes.
  - Both `getFieldValue` and `setFieldValue` check the Jira REST response
    status and throw a descriptive error on failure. Earlier versions of
    `setFieldValue` didn't check the PUT's response at all, so a failed save
    (e.g. hitting the size limit) would silently report `{ ok: true }` to the
    client while nothing was actually saved — don't reintroduce that.
- `mermaid-native/static/main-custom-ui/` — the actual Custom UI React app
  that runs inside Jira's iframe. **Separate `package.json` and webpack
  build** from the outer `mermaid-native/` package — see Dev loop below.
  - `src/App.jsx` — issue panel shell: diagram list, add/remove, per-diagram
    edit/display mode (client-only, not persisted — see GB-seconds note
    above), debounced autosave with a visible save-status indicator,
    conflict-resolution banner, near-size-limit warning, reorder-within-group
    (`moveDiagram`, delegates to `diagram-groups.js`), and the per-node color
    picker toolbar (`renderNodeColorPicker`, delegates to `node-style.js` /
    `state-style.js` depending on diagram type). Persists via
    `invoke('setFieldValue', ...)`.
  - `src/styles.css` — hand-rolled CSS with hardcoded hex colors approximating
    Jira's palette, **not** Atlaskit design tokens. This is deliberate, not
    an oversight — see "Atlaskit components and CSP" below. Has light/dark
    parity with Jira's own chrome (see "Dark mode" in Known state below) —
    still hand-rolled hex values, not real Atlaskit tokens; the investigation
    into whether a statically-loaded token stylesheet exists concluded it
    doesn't (see "Atlaskit components and CSP" below) — don't re-investigate
    that path from scratch.
- `mermaid-native/src/DiagramView.jsx`, `DiagramCanvas.jsx`,
  `mermaid-renderer.js`, `ErrorBoundary.jsx`, `diagram-groups.js`,
  `node-style.js`, `state-style.js` — imported by the Custom UI app via a
  relative path (`../../../src/...`) that reaches *up out of*
  `static/main-custom-ui` into the outer package's `src/`. So there are two
  `src/` trees under `mermaid-native/`: the outer one holds the resolver
  *and* these shared UI/pure-logic pieces, the inner one
  (`static/main-custom-ui/src/`) holds the actual app entry point. Easy to
  get turned around — check which `src/` you're in.
  - `diagram-groups.js` — `buildRenderGroups` (section clustering, moved
    here from `App.jsx` for testability), `moveTargetIndex`/`moveBounds`
    (reorder-within-group logic — see Known state).
  - `node-style.js` — flowchart node-id parsing and `style NodeId
    fill:...,stroke:...,color:...` read/upsert logic behind the color
    picker.
  - `state-style.js` — the state-diagram equivalent, but a genuinely
    different mechanism (`classDef`/`class`, not `style` — see the CSP
    section below); don't assume the two are interchangeable.

## Atlaskit components and CSP

The app originally used `@atlaskit/button/new` and `@atlaskit/textfield` and
they rendered completely unstyled in real Jira (structurally present, zero
CSS — "Windows 95" look) even after fixing the webpack CSS pipeline below.
Likely mechanism (observed, not fully proven): `@atlaskit/button/new` is
built on `@atlaskit/primitives/pressable`, which is styled via
`@emotion/react` (`css`/`jsx` imports), a runtime CSS-in-JS library that
injects a `<style>` tag into the page — plausibly hitting the same CSP
restriction documented below for Mermaid's own `<style>` output. Treat this
as the leading theory, not settled fact — `@atlaskit/textfield`'s outline
did partially render (a blue focus border was visible) even while Button
looked fully bare, which doesn't cleanly fit "all Emotion output is
blocked," so something more selective may be going on. It wasn't run down
further because the fix doesn't depend on the exact cause either way: those
components were **replaced with plain `<button>`/`<input>`/`<select>`
elements styled via `styles.css`** (`.btn`, `.text-input`, `.select-input`
classes), which sidesteps the question by not depending on any runtime CSS
injection at all.

Not every Atlaskit package has this problem — `@atlaskit/section-message`,
`@atlaskit/spinner`, and `@atlaskit/icon` all render correctly and are still
used. The difference: those ship real `*.compiled.css` files (Atlaskit's
newer "Compiled" CSS-in-JS, extracted to static CSS at Atlaskit's own publish
time) that flow through webpack's normal `.css` module rule like any other
imported stylesheet — no runtime injection involved. You can tell which
category a component falls into by checking whether a `webpack --mode
production` build output lists a `*.compiled.css` module for it (see Dev
loop → Build). If a new Atlaskit component is needed, check this before
assuming it'll look right: it might, if it's been migrated to Compiled; if it
still resolves to `@emotion/react`, expect it to render unstyled and plan to
either hand-style around it or replace it, the same way this app already did
for Button/TextField.

**These Compiled components don't participate in this app's dark mode,
and that's deliberate, not an oversight.** Their `*.compiled.css` references
real Atlaskit design-token CSS custom properties (`var(--ds-text,#172b4d)`,
`var(--ds-border-radius,4px)`, etc. — dozens of them across
Spinner/SectionMessage's actual usage, hundreds if you count every value
their shared `@atlaskit/primitives` Box utility could theoretically emit).
Confirmed by direct inspection: **no static CSS file defining these
`--ds-*` variables ships anywhere in `@atlaskit/tokens`** — theming is
entirely a runtime mechanism (`setGlobalTheme`/`getThemeStyles`, which
constructs and injects a stylesheet at runtime), the same category of
CSP risk already established for Button/TextField above, not something to
assume is safe just because it's "just CSS variables." Hand-authoring a
matching light/dark `--ds-*` stylesheet ourselves was considered and
rejected: it would pin this app to Atlaskit's *undocumented* internal
variable names (not a supported API) for two small, transient UI elements
(a loading spinner, warning/error banners) — a standing fragility risk
(silent breakage on an Atlaskit version bump) judged disproportionate to
the payoff. If this is ever revisited, redo the "which `--ds-*` names does
the actual rendered output use" check fresh against the then-current
Atlaskit version rather than trusting this list to still be accurate.

## The CSP / styling constraint (central to "let users style diagrams")

Forge Custom UI's CSP blocks inline `<style>` tags and inline `style="..."`
attributes — both of which Mermaid's theming normally relies on.

Current workaround, in `mermaid-native/src/mermaid-renderer.js`:
`htmlLabels: false` everywhere (forces plain SVG `<text>` instead of
foreignObject/HTML labels), plus `inlineSvgStyles()`, which handles **two
separate sources** of style Mermaid emits, both needing conversion:
1. The `<style>` block's CSS class rules (theme colors) — parsed and baked
   into presentation attributes on matching elements.
2. Per-node `style NodeId fill:#...,stroke:...,color:...` directives (a
   diagram author styling one specific node) — these come out as a literal
   `style="..."` attribute *directly on that element*, a completely
   different code path from the `<style>` block. Easy to miss: an earlier
   version of this function only handled (1), so per-node custom colors
   silently rendered as flat theme-default colors instead of what was
   actually requested — the CSP dropped the inline `style` attribute and
   nothing converted it. Fixed by also parsing `[style]` elements
   (`parseInlineStyleAttr`) and applying those *after* the class-rule pass,
   unconditionally overwriting (not guarded by `!hasAttribute`) — a per-node
   inline style should win over a theme class rule, matching normal CSS
   cascade/specificity, and only an unconditional overwrite reproduces that
   once everything's flattened into plain attributes with no cascade of
   their own.

**Only the properties listed in `STYLE_PROPS_TO_ATTRS` survive this
translation.** Any diagram-styling feature (theme picker, per-node color
overrides, custom fonts, etc.) must do one of:
1. Work through CSS properties already in that whitelist, or
2. Extend `STYLE_PROPS_TO_ATTRS` with the new CSS property → SVG attribute
   mapping, or
3. Use Mermaid config/directives that Mermaid itself emits as presentation
   attributes rather than CSS — verify this against actual render output,
   don't assume from Mermaid's docs.

**The class-rule pass (1 above) must respect `!important`, and used not
to.** It originally applied class rules in whatever order
`sheet.cssRules` yielded them, skipping a declaration if the element
already had that attribute (`!el.hasAttribute(attr)`) — i.e. first-rule-
processed always won, full stop. This is wrong per real CSS cascade
semantics, and it silently broke the per-state color picker for state
diagrams (`state-style.js`): Mermaid's base theme always emits a generic
rule like `.node rect{fill:#ECECFF;...}` *before* a `classDef`-derived
override like `.nodeStyle_A rect{fill:red!important;...}` in the
stylesheet, so the generic rule claimed `fill`/`stroke` first and the
`!important` override — which Mermaid deliberately marks `!important`
specifically so it wins — got skipped. Only the state's *text* color
happened to render correctly, because no earlier generic rule had already
claimed `fill` on that specific `<tspan>`. Confirmed by actually rendering
through the real `mermaid` package with `jsdom` supplying the DOM APIs
(`DOMParser`/`CSSStyleSheet`/`XMLSerializer`) as a scratch diagnostic, not
guessed from reading the code — `mermaid.render()` needs a `document`
global that plain Node doesn't have, and jsdom needs
`SVGElement.prototype.getBBox`/`getComputedTextLength` polyfilled since it
doesn't implement real layout. Fixed by applying class rules in two
passes: normal declarations first (unchanged, first-write-wins), then a
second pass that always overwrites for any declaration that was
`!important` (via `rule.style.getPropertyPriority(prop)`) — matching
`!important`'s real semantics of winning regardless of source order. Also
defensively strips a literal trailing `!important` off the extracted
value before using it (`value.replace(/\s*!important\s*$/i, '')`): some
CSSOM implementations return it as part of `getPropertyValue()`'s result
rather than exposing it only via `getPropertyPriority()`, and left in,
it's invalid syntax as an SVG attribute value, breaking the fill instead
of applying the requested color. This class-rule pass is shared by both
flowchart and state-diagram rendering, so a future change here needs
re-verifying against both, not just whichever one prompted the change.

**Flowchart and state-diagram per-node coloring are two genuinely
different Mermaid mechanisms — don't assume one implies the other.**
Verified directly against the real `mermaid` package's parser (not
assumed from docs or memory): flowcharts accept a single `style NodeId
fill:...,stroke:...,color:...` line (handled by (2) above, `node-style.js`
manages it). State diagrams (`stateDiagram-v2`) *reject* that exact syntax
as a parse error — their only per-state coloring mechanism is
`classDef className fill:...` + `class StateId className`, two
coordinated lines instead of one (`state-style.js` manages both together
under a deterministic per-state class name, `nodeStyle_<stateId>`, so it
reads/writes like a single per-state style from the picker's point of
view even though it's backed by two source lines). Sequence, ER, pie, and
gantt diagrams have **no** per-element style directive at all — checked
by attempting `style`, `classDef`/`class`, and (for sequence diagrams)
`rect rgb(...)...end` region-highlighting against the real parser; only
the last one parses, and it colors a *range of messages*, not a specific
participant, so it isn't a substitute. The per-node color picker in
`App.jsx` only renders for flowchart/state-diagram source for exactly this
reason — extending it to another diagram type needs the same "does
Mermaid actually support this" check against the real parser before
writing any parsing/upsert logic, not an assumption that it's just a
matter of writing a similar module.

The per-diagram style picker (`diagram.theme`, one of Mermaid's built-in
themes — see `MERMAID_THEMES` in `mermaid-renderer.js`) uses option 3: it
prepends a `%%{init: {"theme": "..."}}%%` directive to the source before
rendering (`withTheme()`), rather than calling `mermaid.initialize()` again
per diagram. Don't switch this to a global re-`initialize()` call — multiple
`DiagramView`s can render concurrently, and `initialize()` is global mutable
state shared across all of them.

Verify any styling change by inspecting the real rendered SVG (e.g. via
browser devtools/Playwright against the deployed app), not just by trusting
Mermaid's theme documentation — Forge's CSP silently drops whatever the
whitelist doesn't cover, with no error.

## Dev loop

- **Install**: `npm install` at `mermaid-native/` root — its `postinstall`
  cascades into `npm install --prefix static/main-custom-ui`.
- **Build**: `npm run build` at `mermaid-native/` root — this runs
  `build --prefix static/main-custom-ui`, i.e. it builds the *inner* Custom
  UI package (webpack production build + copies `public/icon.svg` into
  `build/`), not the outer package itself. Be deliberate about which of the
  two `package.json`s you're actually targeting.
- **Forge CLI gotcha**: `/usr/bin/forge` on this machine is an unrelated
  bioinformatics tool (SNAP gene predictor) — a real name collision, not the
  Atlassian CLI. Always invoke Forge via `npx forge <cmd>` from inside
  `mermaid-native/` (where `@forge/cli` is a devDependency), never bare
  `forge`.
- **Node version**: `mermaid-native/.nvmrc` pins `22.22.3` — run
  `nvm use` (or `source ~/.nvm/nvm.sh && nvm use 22.22.3`) before any `forge`/
  `npm` command in a fresh shell; nvm's PATH change doesn't persist across
  separate shell invocations (e.g. separate tool calls), so this needs
  re-running each time, not just once per session. `22.22.3` isn't an
  arbitrary pin: `@forge/cli@13` (see below) rejects Node with an *exact
  patch exclusion* — its actual engines range is roughly
  `>=20.18.1 <22.23.1 || >22.23.1 <24.17.0 || >24.17.0`, meaning it refuses
  precisely `22.23.1` and precisely `24.17.0` while accepting everything
  else nearby. Don't assume "any 22.x/24.x works" — check the CLI's actual
  error if you bump the pinned version and it starts refusing to run.
- **Forge CLI version**: pinned via `mermaid-native/package.json`'s
  `@forge/cli` devDependency (currently `^13.0.0`) — reinstall
  (`npm install`) after bumping it, don't rely on a global `forge` install
  (see the name-collision gotcha above; there isn't one on this machine
  anyway). `@forge/cli`'s own bundled dependencies carry a long-standing set
  of `npm audit` findings (websocket-driver, `ws`, `yaml`, ...); these are
  Atlassian's CLI's own dev-time tooling deps, not anything shipped in the
  deployed app, and `npm audit fix --force` would mean downgrading/pinning
  around Atlassian's own package — left alone deliberately, don't chase
  this without a specific reason.
- **Deploy**: `npx forge deploy`, then `npx forge install --upgrade` against
  the connected site.
- **Verify visually**: this project has been tested by driving a real
  browser against a connected Jira Cloud test/dev site (see `.playwright-mcp/`
  for past session artifacts, if present — that directory is gitignored, not
  part of the published repo). Prefer an actual browser check over assuming a UI/styling
  change looks right — it renders inside Jira's iframe under production CSP,
  which no local/isolated preview reproduces.

## Known state (as of last review)

Works as a POC and is now under version control (git, initialized at the
workspace root — `.env` and `.playwright-mcp/` are gitignored). Diagrams have
a per-diagram edit/display mode, a debounced autosave with a visible
save-status indicator, a Mermaid built-in-theme picker, and pan/zoom
(`mermaid-native/src/DiagramCanvas.jsx` — wheel to zoom, drag to pan,
+/−/reset controls, implemented via `viewBox` attribute manipulation, not
CSS transforms, for the same CSP reason as everything else here) plus a
fullscreen toggle (a `position: fixed` overlay covering the panel as the
guaranteed baseline, with the real browser Fullscreen API attempted on top
as a best-effort upgrade — Forge controls this iframe's embedding, not this
app, so whether Jira grants `allow="fullscreen"` isn't something to assume
either way; a rejected `requestFullscreen()` is silently ignored and the
CSS overlay still works). Buttons/
inputs are hand-styled plain HTML, not Atlaskit components (see "Atlaskit
components and CSP"). The resolver has optimistic-concurrency conflict
detection and entity-property size-limit enforcement (see Architecture).
Node/Forge CLI versions are pinned (`.nvmrc`, `@forge/cli@^13`) to versions
verified to actually work together on this machine. Diagrams can be
reordered (up/down buttons; changes array order, which is real content, so
it persists) and collapsed to just their header in display mode (client-only
state, like edit/display mode — see the GB-seconds note above). Diagrams can
also be grouped into named, collapsible sections via a `section` string field
on each diagram (real, persisted content — unlike collapse/edit-display
state). Grouping is render-time only: `buildRenderGroups()` (moved to
`diagram-groups.js` for testability) clusters diagrams sharing a section
name wherever that name first appears in the flat array, but storage order,
conflict detection, and the size-limit math all still operate on that same
flat `diagrams` array, untouched by grouping.

**Reorder now stays within a diagram's own group.** The up/down buttons
used to swap a diagram with whatever was flat-array-adjacent, regardless of
section — since grouping clusters by content (matching section name), not
physical array position, this didn't visually split a section, but it did
mean a diagram's apparent position within its own group could jump or
silently not move depending on what else sat between it and its section-
mates in the flat array, and the disabled state for the buttons used
flat-array bounds instead of group-relative ones. `diagram-groups.js`'s
`moveTargetIndex`/`moveBounds` fix this: a sectioned diagram always swaps
with its *nearest same-section* neighbor's flat index (skipping over
whatever else sits physically between them), and the up/down buttons
disable based on position within the group, not the flat array. An
unsectioned diagram's behavior is unchanged (flat-array-adjacent swap).

**Dark mode** follows Jira's own light/dark/auto preference. The signal is
`view.getContext()`'s `theme.colorMode` (`'light' | 'dark' | 'auto'`, or
absent on older `@forge/bridge` versions) — confirmed via that package's
own type definitions to be plain JSON delivered over the bridge, not a
runtime style/script injection, so it doesn't hit the CSP issue documented
below for Atlaskit components. `resolveEffectiveDark()` in `App.jsx`
resolves this down to a boolean once at panel load (`'auto'`/absent falls
back to `window.matchMedia('(prefers-color-scheme: dark)')`) and
`applyColorMode()` sets `<html data-color-mode="light"|"dark">`
accordingly — `styles.css`'s `:root[data-color-mode='dark']` block is the
single source of truth for the dark palette (there's deliberately no
parallel `@media (prefers-color-scheme: dark)` block to keep in sync by
hand; resolving 'auto' in JS made that redundant, and the earlier version
of this that had both was a maintenance-drift risk in review). This is
read once at load, not observed live — a Jira theme change while the panel
is already open needs a reload to pick up. **Known, accepted gap:**
`@atlaskit/spinner`'s and `@atlaskit/section-message`'s own colors don't
follow this (see "Atlaskit components and CSP" above for why that's a
deliberate tradeoff, not an oversight) — everything else (hand-rolled
buttons/inputs, card chrome, diagram surfaces) does.

**A diagram's own surface (background) follows *its own* Mermaid theme,
not Jira's chrome dark mode — these are independent settings, and
conflating them was a real regression caught during review.** The preview
pane, inline display, and fullscreen backdrop all read a `data-surface`
attribute (`"light"` or `"dark"`) that `DiagramCanvas.jsx` sets from
`isDarkMermaidTheme(diagram.theme)` (`mermaid-renderer.js` — true only for
Mermaid's `'dark'` theme). Do not key this off Jira's `data-color-mode`
instead: an earlier version did exactly that, and it broke fullscreen —
a diagram using one of the light Mermaid themes (Default/Neutral/Forest)
has text/edge-label colors that assume a light backdrop, and switching the
backdrop to dark chrome-side made that text nearly invisible while leaving
the diagram's own colors untouched. **New diagrams default their Mermaid
theme to `'dark'` when the panel is effectively in dark mode** (same
`effectiveDark` resolution as above), `'default'` otherwise — deliberately
only affects diagrams that don't exist yet; no auto-switching of an
existing diagram's theme, since that would change what already-authored
content renders as out from under whoever's viewing it.

**Per-node color picker**, for flowchart and state diagrams (see the CSP
section above for exactly why those two and not sequence/ER/pie/gantt, and
why flowchart and state-diagram styling need genuinely different
read/write logic despite looking like they should be the same feature).
Shown in edit mode only, next to the existing theme/section toolbar. One
gotcha already hit: the color `<input type="color">`s must **not** use
`{ immediate: true }` on `onChange` — a native color input fires `onChange`
continuously while its picker is being dragged (many times a second, not
once on release), and firing an immediate save per drag tick raced
multiple concurrent `setFieldValue` calls against the app's own
optimistic-concurrency check (each one reads `baseSnapshotRef.current`
before any of the earlier in-flight ones has completed and updated it),
surfacing as a spurious "someone else changed these diagrams" conflict
banner against the app's *own* rapid-fire edits — looking, to a user
dragging a color slider, exactly like the app was overwriting their own
in-progress work. Fixed by treating color-dragging like continuous typing
(debounced, via plain `updateDiagram(id, patch)` with no `immediate`
option, flushed via `onBlur={flushSave}`), the same pattern already used
for the source textarea — not like a discrete dropdown pick. The "Reset
node" button is a genuine discrete action and correctly keeps
`{ immediate: true }`.

**Gotcha already hit once:** the Section `<input>` cannot be wired straight
to `diagram.section` via `onChange` — each render-group wrapper is keyed by
the section name (`` key={`section-${group.name}`} ``), so every keystroke
that changes the name (e.g. "A" → "Ar" → "Arc" while typing "Architecture")
produces a *new* wrapper element. React can't reconcile that as "the same
input, just moved" (its parent in the tree is now literally a different
element), so it unmounts and remounts the input on every keystroke —
dropping focus after each character. Fixed with a local `sectionDraft`
buffer: the input shows/edits `sectionDraft[id] ?? diagram.section` and only
commits to `diagram.section` (which drives grouping) on blur. If any other
field ever needs to double as a grouping/structural key, it'll need the same
draft-until-commit treatment — anything read by `buildRenderGroups` is
unsafe to bind directly to a live-typing input's `onChange`. Pure-logic
functions (`stable-json.js`, `mermaid-renderer.js`'s `withTheme`/
`safeDiagramId`/`readableParseError`/`isDarkMermaidTheme`, `diagram-groups.js`,
`node-style.js`, `state-style.js`) have unit tests under `src/*.test.js`
(40 tests total as of last review), run via `npm test` (Node's built-in
test runner — no test framework dependency) and in CI
(`.github/workflows/ci.yml`, runs on push/PR, no Atlassian credentials
needed since it only does `npm test` + `npm run build`, deliberately not
`forge lint`/`forge deploy`). Resolver logic (`getFieldValue`/
`setFieldValue`) is *not* unit tested — it would require mocking
`@forge/api`/`@forge/resolver`, which wasn't judged worth the fragility;
its highest-risk piece (conflict comparison) is covered indirectly via
`stable-json.test.js` instead. `inlineSvgStyles()` (the CSS-to-attribute
baking in `mermaid-renderer.js`) is also not unit tested — it needs real
DOM APIs (`DOMParser`/`CSSStyleSheet`/`XMLSerializer`) that plain Node
doesn't have; it was checked with a one-off `jsdom`-backed scratch script
while diagnosing the `!important` cascade bug above, not added as a
permanent test, matching this project's existing convention of verifying
rendering-dependent code in a real browser rather than automating it
around a DOM shim.

Remaining rough edges: `@atlaskit/spinner`/`@atlaskit/section-message`
don't follow dark mode (deliberate, see "Atlaskit components and CSP"), no
per-node color picker for sequence/ER/pie/gantt diagrams (Mermaid itself
has no mechanism for it — verified, not just unbuilt), the split `src/`
layout described above, and no automated UI/rendering or
resolver-integration tests.
