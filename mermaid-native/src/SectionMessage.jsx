import React from 'react';

// Stand-in for @atlaskit/section-message. The real component unconditionally
// renders an internal appearance icon through @atlaskit/icon's legacy Icon,
// which uses Emotion's `css` prop plus a literal `style` prop — both inline
// styles that Forge Custom UI's CSP blocks (no 'unsafe-inline' in
// style-src). There's no way to opt out of that icon from the outside, so
// the whole component is replaced rather than just the icon. See
// mermaid-native/CLAUDE.md "Atlaskit components and CSP".
export default function SectionMessage({ appearance = 'information', title, children }) {
  return (
    <div className={`section-message section-message-${appearance}`}>
      {title && <div className="section-message-title">{title}</div>}
      <div className="section-message-body">{children}</div>
    </div>
  );
}
