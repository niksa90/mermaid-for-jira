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
    conflict-resolution banner, near-size-limit warning. Persists via
    `invoke('setFieldValue', ...)`.
  - `src/styles.css` — hand-rolled CSS with hardcoded hex colors approximating
    Jira's palette, **not** Atlaskit design tokens. This is deliberate, not
    an oversight — see "Atlaskit components and CSP" below. No light/dark
    theme parity with Jira yet; if that's ever wanted, it'd need real CSS
    custom properties from a statically-loaded token stylesheet (verify such
    a thing exists and is CSP-safe before assuming — don't just re-add
    `@atlaskit/tokens` and expect it to work).
- `mermaid-native/src/DiagramView.jsx`, `mermaid-renderer.js`,
  `ErrorBoundary.jsx` — imported by the Custom UI app via a relative path
  (`../../../src/...`) that reaches *up out of* `static/main-custom-ui` into
  the outer package's `src/`. So there are two `src/` trees under
  `mermaid-native/`: the outer one holds the resolver *and* these shared UI
  pieces, the inner one (`static/main-custom-ui/src/`) holds the actual app
  entry point. Easy to get turned around — check which `src/` you're in.

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
state). Grouping is render-time only: `buildRenderGroups()` in `App.jsx`
clusters diagrams sharing a section name wherever that name first appears in
the flat array, but storage order, reorder (up/down), conflict detection,
and the size-limit math all still operate on that same flat `diagrams`
array, untouched by grouping. One known rough edge: the up/down reorder
buttons move a diagram by flat-array index, not by position-within-its-group
— moving a grouped diagram can visually jump it across a section boundary
one step at a time rather than staying within the group. Not fixed
intentionally (simpler, and not yet asked for); revisit if it's confusing in
practice.

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
`safeDiagramId`/`readableParseError`) have unit tests under `src/*.test.js`,
run via `npm test` (Node's built-in test runner — no test framework
dependency) and in CI (`.github/workflows/ci.yml`, runs on push/PR, no
Atlassian credentials needed since it only does `npm test` + `npm run
build`, deliberately not `forge lint`/`forge deploy`). Resolver logic
(`getFieldValue`/`setFieldValue`) is *not* unit tested — it would require
mocking `@forge/api`/`@forge/resolver`, which wasn't judged worth the
fragility; its highest-risk piece (conflict comparison) is covered
indirectly via `stable-json.test.js` instead.

Remaining rough edges: no dark-mode/theme parity with Jira's own UI, flat
diagram list with no reordering/grouping, no per-node/custom-color styling
(only Mermaid's four built-in themes), the split `src/` layout described
above, and no automated tests or CI.
