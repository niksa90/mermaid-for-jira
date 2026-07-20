import React, { useEffect, useRef, useState } from 'react';
import SectionMessage from '@atlaskit/section-message';
import Spinner from '@atlaskit/spinner';
import { renderMermaid, safeDiagramId, withTheme } from './mermaid-renderer';
import DiagramCanvas from './DiagramCanvas';

/** Renders a single Mermaid source string to SVG, showing a spinner while
 * parsing and a readable inline error if the source is invalid. */
export default function DiagramView({ source, theme = 'default', idPrefix = 'diagram', index = 0 }) {
  const [svg, setSvg] = useState(null);
  const [error, setError] = useState(null);
  const idRef = useRef(safeDiagramId(idPrefix, index));

  useEffect(() => {
    let cancelled = false;
    setError(null);
    renderMermaid(idRef.current, withTheme(source, theme))
      .then((result) => {
        if (!cancelled) setSvg(result);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
          setSvg(null);
        }
      });
    return () => {
      cancelled = true;
    };
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

  return <DiagramCanvas svg={svg} />;
}
