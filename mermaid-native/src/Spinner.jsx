import React from 'react';

// Stand-in for @atlaskit/spinner. The real component sets `animationDelay`,
// `width`/`height`, and `stroke` via a literal React `style` prop on every
// render — an inline style attribute, which Forge Custom UI's CSP blocks
// (no 'unsafe-inline' in style-src). This gets its sizing entirely from
// `.spinner-{size}` classes in styles.css instead, so nothing here ever
// touches the `style` attribute. See mermaid-native/CLAUDE.md "Atlaskit
// components and CSP".
export default function Spinner({ size = 'medium', label }) {
  return (
    <span
      className={`spinner spinner-${size}`}
      role={label ? 'img' : 'presentation'}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
    />
  );
}
