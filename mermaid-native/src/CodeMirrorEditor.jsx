import { useEffect, useRef, useState } from 'react';
import Spinner from './Spinner';

let cmPromise = null;
/** Lazily loads CodeMirror so it isn't in the main bundle — it's only ever
 * needed once a diagram is actually being edited, not just viewed, the same
 * reasoning mermaid-renderer.js already applies to lazy-loading `mermaid`
 * itself. Bundled directly, CodeMirror alone nearly tripled the main
 * bundle's size (measured: ~205KB -> ~580KB). */
function loadCodeMirror() {
  if (!cmPromise) {
    cmPromise = Promise.all([
      import(/* webpackChunkName: "codemirror" */ 'codemirror'),
      import(/* webpackChunkName: "codemirror" */ '@codemirror/state'),
      import(/* webpackChunkName: "codemirror" */ '@codemirror/view'),
      import(/* webpackChunkName: "codemirror" */ '@codemirror/language'),
      import(/* webpackChunkName: "codemirror" */ './codemirror-mermaid-lang.js'),
    ]);
  }
  return cmPromise;
}

/**
 * Thin React wrapper around a plain CodeMirror 6 EditorView — no
 * @uiw/react-codemirror or similar, matching this project's pattern of
 * hand-rolling thin wrappers over an underlying primitive rather than
 * adding a wrapper-of-a-wrapper dependency (see icons.jsx/Spinner.jsx/
 * SectionMessage.jsx for the same approach applied to Atlaskit).
 *
 * Line numbers, history, and bracket matching, and built-in search all
 * come from `basicSetup`; Mermaid syntax highlighting comes from
 * codemirror-mermaid-lang.js's hand-rolled StreamLanguage scanner (see
 * that file for why — no maintained CodeMirror 6 Mermaid grammar exists).
 * CodeMirror 6 renders cursor/selection via inline styles it injects
 * itself, which only works now that
 * manifest.yml declares `permissions.content.styles: ['unsafe-inline']`
 * — this component is the actual end-to-end test of whether that
 * permission does what Forge's docs (silently) implied it does.
 */
// CodeMirror's own default styling is light-only (a white gutter/background
// regardless of surrounding chrome). Rather than a separate hardcoded dark
// theme to keep in sync by hand, this reads the same CSS custom properties
// styles.css already flips via `:root[data-color-mode='dark']` — the exact
// pattern the rest of this app's dark mode already follows (see CLAUDE.md's
// "Dark mode" note) — so CodeMirror's chrome follows Jira's light/dark
// chrome automatically, the same as every other input/button in this app.
function editorTheme(EditorView) {
  return EditorView.theme({
    // Transparent, not --color-input-bg: the wrapping .codemirror-editor
    // div now supplies a uniform --color-subtle-bg panel behind both this
    // and .cm-gutters below (a soft gray fill replacing the editor's old
    // hard 1px border — see styles.css), so the content area shouldn't
    // paint its own, different-colored background over that.
    '&': {
      color: 'var(--color-text)',
      backgroundColor: 'transparent',
    },
    '.cm-content': {
      caretColor: 'var(--color-text)',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--color-subtle-bg)',
      color: 'var(--color-text-subtle)',
      border: 'none',
    },
    // color-mix(...transparent), not a plain opaque --color-subtle-bg:
    // CodeMirror's own selection-highlight layer (.cm-selectionBackground,
    // from drawSelection() in basicSetup) renders at z-index: -2 — behind
    // .cm-line's normal content flow, by design, so it shows through any
    // *translucent* line background but is fully hidden by an *opaque*
    // one. A solid fill here meant selecting text on the line the cursor
    // is already on (the common case: you select a line, which puts the
    // cursor there) showed no visible selection highlight at all — a real
    // bug report, not a hypothetical (same problem, same fix needed, for
    // .cm-error-line below). CodeMirror's own bundled default theme uses
    // exactly this technique (a semi-transparent activeLine tint) for the
    // same reason; this app's version just wasn't translucent.
    '.cm-activeLine': {
      backgroundColor: 'color-mix(in srgb, var(--color-subtle-bg) 55%, transparent)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'var(--color-subtle-bg-hover)',
    },
    // Must be registered here, in the same EditorView.theme() call as
    // .cm-activeLine above (and after it) — not as a plain class in
    // styles.css. EditorView.theme() rewrites a bare selector like
    // `.cm-activeLine` into `.cm-editor.<generated-scope-class>
    // .cm-activeLine` (confirmed by reading @codemirror/view's own
    // buildTheme()/StyleModule source, not guessed), which has strictly
    // higher CSS specificity than a plain `.cm-error-line` class rule
    // sitting in the app's static stylesheet. The line CodeMirror's own
    // cursor sits on always carries both classes simultaneously — which is
    // also the single most common case in practice, since a user is
    // usually actively editing the line that just broke — so a
    // lower-specificity rule for the error highlight was silently losing
    // to the active-line one every time the two coincided. Landing it in
    // this same theme call gives it identical (tied) specificity, and
    // later-in-source-order wins a specificity tie, so listing it after
    // '.cm-activeLine' here is what makes it actually win.
    // Translucent for the same reason as .cm-activeLine above — an opaque
    // fill here would hide the selection highlight whenever the errored
    // line is also selected (e.g. selecting it to copy/report the error).
    '.cm-error-line': {
      backgroundColor: 'color-mix(in srgb, var(--color-danger-bg-hover) 65%, transparent)',
    },
  });
}

export default function CodeMirrorEditor({ value, onChange, onBlur, errorLine }) {
  const containerRef = useRef(null);
  const viewRef = useRef(null);
  const onChangeRef = useRef(onChange);
  const onBlurRef = useRef(onBlur);
  // Set once CodeMirror has loaded, alongside the StateEffect that drives
  // errorLineField below — held in a ref (not state) since dispatching it
  // doesn't need a React re-render, just a CodeMirror transaction.
  const setErrorLineEffectRef = useRef(null);
  const [ready, setReady] = useState(false);
  onChangeRef.current = onChange;
  onBlurRef.current = onBlur;

  useEffect(() => {
    let cancelled = false;
    loadCodeMirror().then(
      ([
        { basicSetup },
        { EditorState, StateEffect, StateField },
        { EditorView, Decoration },
        { syntaxHighlighting },
        { mermaidLanguage, mermaidHighlightStyle },
      ]) => {
      if (cancelled) return;

      // Highlights the source line a Mermaid parse error points at (see
      // extractErrorLine in mermaid-renderer.js) — a StateField driven by a
      // StateEffect rather than a one-off DOM class toggle, since CodeMirror
      // owns and re-renders its own DOM on every edit; a field is what
      // survives that and stays correctly positioned as the user keeps
      // typing (mapped through `tr.changes` like any other decoration).
      const setErrorLine = StateEffect.define();
      setErrorLineEffectRef.current = setErrorLine;
      const errorLineField = StateField.define({
        create: () => Decoration.none,
        update(deco, tr) {
          for (const effect of tr.effects) {
            if (effect.is(setErrorLine)) {
              if (effect.value == null) return Decoration.none;
              const lineNumber = Math.min(Math.max(1, effect.value), tr.state.doc.lines);
              const line = tr.state.doc.line(lineNumber);
              return Decoration.set([
                Decoration.line({ attributes: { class: 'cm-error-line' } }).range(line.from),
              ]);
            }
          }
          return deco.map(tr.changes);
        },
        provide: (field) => EditorView.decorations.from(field),
      });

      const view = new EditorView({
        state: EditorState.create({
          doc: value || '',
          extensions: [
            basicSetup,
            mermaidLanguage,
            syntaxHighlighting(mermaidHighlightStyle),
            editorTheme(EditorView),
            errorLineField,
            EditorView.lineWrapping,
            EditorView.contentAttributes.of({ spellcheck: 'false' }),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) {
                onChangeRef.current(update.state.doc.toString());
              }
            }),
            EditorView.domEventHandlers({
              blur: () => onBlurRef.current?.(),
            }),
          ],
        }),
        parent: containerRef.current,
      });
      viewRef.current = view;
      setReady(true);
    });
    return () => {
      cancelled = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // Only the initial value seeds the editor; external updates are synced
    // by the effect below, not by recreating the view (which would drop
    // cursor position/undo history on every keystroke echoed back from
    // React state).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Syncs external value changes (e.g. switching which diagram is shown)
  // into the already-mounted editor. Guarded on an actual diff so this
  // doesn't fight the user's own typing: onChange already updated `value`
  // to match what CodeMirror holds by the time this re-runs, so the
  // common case is a same-value no-op.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    const next = value || '';
    if (current !== next) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: next } });
    }
  }, [value]);

  // Re-highlights (or clears) the error line whenever the parse result
  // upstream (DiagramView's onError) changes — independent of the doc-sync
  // effect above, since an error can clear/change without the source text
  // itself changing (e.g. switching themes doesn't touch source, but a fix
  // to an earlier line does change source without necessarily changing
  // which line the *next* error points at).
  useEffect(() => {
    const view = viewRef.current;
    const setErrorLine = setErrorLineEffectRef.current;
    if (!view || !setErrorLine) return;
    view.dispatch({ effects: setErrorLine.of(errorLine ?? null) });
  }, [errorLine, ready]);

  return (
    <div className="codemirror-editor">
      {!ready && (
        <div className="codemirror-loading">
          <Spinner size="small" label="Loading editor" />
        </div>
      )}
      <div ref={containerRef} className={ready ? '' : 'codemirror-editor-hidden'} />
    </div>
  );
}
