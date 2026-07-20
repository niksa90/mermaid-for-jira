---
name: forge-build-deploy
description: Build, deploy, and browser-verify the mermaid-native Forge app on the connected Jira Cloud test site. Use whenever changing anything under mermaid-native/ (resolver, Custom UI, manifest) and needing to see it running in real Jira, or when a `forge` command misbehaves.
---

# Forge build/deploy loop

This app has two `package.json`s: `mermaid-native/` (outer, resolver +
Forge manifest) and `mermaid-native/static/main-custom-ui/` (inner, the
React app that actually runs in Jira's iframe). Run every command from
`mermaid-native/` unless a step says otherwise.

## 1. Install (only if dependencies changed)

```
cd mermaid-native && npm install
```

`postinstall` cascades into the inner package automatically
(`npm install --prefix static/main-custom-ui`) — don't `cd` into it and
install separately unless debugging an inner-package-only issue.

## 2. Build the Custom UI bundle

```
cd mermaid-native && npm run build
```

This proxies to the inner package's webpack production build and copies
`public/icon.svg` into `build/`. Forge deploys whatever is in
`static/main-custom-ui/build/` per `manifest.yml`'s `resources` entry — a
stale or skipped build means `forge deploy` ships old UI code with no error.

## 3. Deploy and install on the test site

**Gotcha**: `forge` on PATH (`/usr/bin/forge`) is an unrelated bioinformatics
tool on this machine — a genuine name collision. Always use `npx forge`, run
from inside `mermaid-native/` where `@forge/cli` is a devDependency.

```
cd mermaid-native
npx forge lint          # catch manifest/scope issues before deploying
npx forge deploy
npx forge install --upgrade
```

If any `npx forge` command fails oddly or warns about Node version, try
`nvm use 22` first (Forge CLI wants 22.x/24.x; this machine's default is
20.x via nvm) before treating it as a real bug.

`forge install --upgrade` targets whatever site is already connected for
this app — check `.env` at the workspace root for which test site that is
before assuming. Don't run bare `forge install` (first-time install flow)
on a site that's already connected.

## 4. Verify in a real browser

Local component previews can't reproduce Jira's production CSP (see
`CLAUDE.md`'s CSP section) — a change that looks right in isolation can
silently fail once deployed. After deploying:

- Open the connected test site's issue with the Mermaid panel and check the
  actual rendered output, not just that the build succeeded.
- Use browser devtools/console to check for CSP violations or swallowed
  errors — Mermaid rendering failures here tend to fail silently rather than
  throwing where you'd notice.
- `.playwright-mcp/` holds artifacts from past verification sessions if you
  need an example of what a prior check looked like.
