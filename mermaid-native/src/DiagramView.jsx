import React, { useEffect, useRef, useState } from 'react';
import SectionMessage from './SectionMessage';
import Spinner from './Spinner';
import { renderMermaid, safeDiagramId, withTheme } from './mermaid-renderer';
import DiagramCanvas from './DiagramCanvas';

/** Renders a single Mermaid source string to SVG, showing a spinner while
 * parsing and a readable inline error if the source is invalid. */
export default function DiagramView({
  source,
  theme = 'default',
  idPrefix = 'diagram',
  index = 0,
  onNodeClick,
  selectedNode,
  // Reports the current parse error (or null once it clears) up to a parent
  // that isn't in this component's own render tree — specifically App.jsx's
  // CodeMirrorEditor, which sits in a sibling pane and needs the offending
  // line number to highlight it. Optional: display-mode DiagramViews (no
  // editor alongside them) don't pass this.
  onError,
  // Click/drag-to-connect (DiagramCanvas.jsx / diagram-connect.js) — both
  // just forwarded straight through, same as onNodeClick/selectedNode
  // above. connectable defaults false so display-mode DiagramViews (no
  // editor alongside them to hold the resulting edge) don't need to pass
  // anything to opt out.
  connectable = false,
  onConnect,
}) {
  const [svg, setSvg] = useState(null);
  const [error, setError] = useState(null);
  const idRef = useRef(safeDiagramId(idPrefix, index));
  // A blank/whitespace-only source is a normal, common state (right after
  // "Add a diagram" template picker defaults to blank, or after clearing
  // everything out of the editor) — not a syntax mistake, so it shouldn't
  // render as a parse-error warning. mermaid-renderer.js's renderMermaid()
  // still throws 'Diagram is empty.' for it (used by the resolver/size
  // checks elsewhere), but this component special-cases it before ever
  // calling that, both to skip the pointless render attempt and to show a
  // materially different, non-alarming message.
  const isEmpty = !(source || '').trim();

  useEffect(() => {
    let cancelled = false;
    setError(null);
    onError?.(null);
    if (isEmpty) {
      setSvg(null);
      return undefined;
    }
    renderMermaid(idRef.current, withTheme(source, theme))
      .then((result) => {
        if (!cancelled) setSvg(result);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
          setSvg(null);
          onError?.({ message: err.message, line: err.line ?? null });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, theme, isEmpty]);

  if (isEmpty) {
    return (
      <SectionMessage appearance="information" title="This diagram is empty">
        <p>Add Mermaid syntax to see it rendered here — the shape palette above the editor can insert some for you.</p>
      </SectionMessage>
    );
  }

  if (error) {
    return (
      <SectionMessage appearance="warning" title="Couldn't parse this diagram">
        <p>{error}</p>
      </SectionMessage>
    );
  }

  if (!svg) {
    return (
      <div className="diagram-loading">
        <Spinner size="medium" label="Rendering diagram" />
      </div>
    );
  }

  return (
    <DiagramCanvas
      svg={svg}
      theme={theme}
      onNodeClick={onNodeClick}
      selectedNode={selectedNode}
      connectable={connectable}
      onConnect={onConnect}
    />
  );
}
