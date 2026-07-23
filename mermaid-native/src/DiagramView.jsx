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
}) {
  const [svg, setSvg] = useState(null);
  const [error, setError] = useState(null);
  const idRef = useRef(safeDiagramId(idPrefix, index));

  useEffect(() => {
    let cancelled = false;
    setError(null);
    onError?.(null);
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
  }, [source, theme]);

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
    <DiagramCanvas svg={svg} theme={theme} onNodeClick={onNodeClick} selectedNode={selectedNode} />
  );
}
