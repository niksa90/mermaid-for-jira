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

## Architecture

- `mermaid-native/manifest.yml` — one `jira:issuePanel` module ("Mermaid
  Diagrams"), Custom UI, backed by one resolver function.
- `mermaid-native/src/resolvers/index.js` — backend resolver
  (`getFieldValue` / `setFieldValue`), calls Jira REST `asUser()`.
- `mermaid-native/static/main-custom-ui/` — the actual Custom UI React app
  that runs inside Jira's iframe. **Separate `package.json` and webpack
  build** from the outer `mermaid-native/` package — see Dev loop below.
  - `src/App.jsx` — issue panel shell: diagram list, add/remove, per-diagram
    edit/display mode, debounced autosave with a visible save-status
    indicator, persists via `invoke('setFieldValue', ...)`.
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
foreignObject/HTML labels), plus `inlineSvgStyles()`, which parses the
`<style>` block Mermaid emits and bakes each rule into presentation
attributes (`fill`, `stroke`, `font-family`, ...) on the matching SVG
elements, then deletes the `<style>` block entirely.

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
  browser against a connected Jira Cloud test site
  (`keephub-test.atlassian.net`; see `.playwright-mcp/` for past session
  artifacts). Prefer an actual browser check over assuming a UI/styling
  change looks right — it renders inside Jira's iframe under production CSP,
  which no local/isolated preview reproduces.

## Known state (as of last review)

Works as a POC. Diagrams have a per-diagram edit/display mode, a debounced
autosave with a visible save-status indicator, and a Mermaid built-in-theme
picker (see above). Buttons/inputs are hand-styled plain HTML, not Atlaskit
components (see "Atlaskit components and CSP"). Remaining rough edges: no
dark-mode/theme parity with Jira's own UI, flat diagram list with no
reordering/grouping, no per-node/custom-color styling (only Mermaid's five
built-in themes), and the split `src/` layout described above.
