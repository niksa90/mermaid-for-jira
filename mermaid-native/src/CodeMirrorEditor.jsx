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
 * Phase 0 spike (see CLAUDE.md): line numbers, history, bracket matching,
 * and built-in search all come from `basicSetup` — no Mermaid-specific
 * syntax highlighting yet. CodeMirror 6 renders cursor/selection via
 * inline styles it injects itself, which only works now that
 * manifest.yml declares `permissions.content.styles: ['unsafe-inline']`
 * — this component is the actual end-to-end test of whether that
 * permission does what Forge's docs (silently) implied it does.
 */
export default function CodeMirrorEditor({ value, onChange, onBlur }) {
  const containerRef = useRef(null);
  const viewRef = useRef(null);
  const onChangeRef = useRef(onChange);
  const onBlurRef = useRef(onBlur);
  const [ready, setReady] = useState(false);
  onChangeRef.current = onChange;
  onBlurRef.current = onBlur;

  useEffect(() => {
    let cancelled = false;
    loadCodeMirror().then(([{ basicSetup }, { EditorState }, { EditorView }]) => {
      if (cancelled) return;
      const view = new EditorView({
        state: EditorState.create({
          doc: value || '',
          extensions: [
            basicSetup,
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
