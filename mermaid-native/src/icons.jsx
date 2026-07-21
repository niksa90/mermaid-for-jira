import React from 'react';

// Plain inline-SVG stand-ins for @atlaskit/icon/glyph/*. The real package's
// legacy Icon component (still the code path taken unless an internal
// Atlaskit feature flag flips it) renders via Emotion's `css` prop and a
// literal `style={{ '--icon-primary-color': ... }}` React prop — both of
// which are inline styles, and Forge Custom UI's CSP blocks all inline
// styles (no 'unsafe-inline' in style-src). These use the identical SVG
// markup Atlaskit ships (`dangerouslySetGlyph` in its glyph modules), just
// rendered with no CSS-in-JS and no `style` prop — sized via width/height
// attributes only, colored via `fill="currentColor"` so it inherits
// whatever text color the surrounding button/element has. See
// mermaid-native/CLAUDE.md "Atlaskit components and CSP".
const SIZE_PX = { small: 16, medium: 24, large: 32 };

function makeIcon(inner) {
  function IconComponent({ label = '', size = 'medium' }) {
    const px = SIZE_PX[size] || SIZE_PX.medium;
    return (
      <svg
        width={px}
        height={px}
        viewBox="0 0 24 24"
        role={label ? 'img' : 'presentation'}
        aria-label={label || undefined}
        aria-hidden={label ? undefined : true}
        className="icon"
        dangerouslySetInnerHTML={{ __html: inner }}
      />
    );
  }
  return IconComponent;
}

export const TrashIcon = makeIcon(
  '<path fill="currentColor" fill-rule="evenodd" d="M5 5a1 1 0 0 0-1 1v1h16V6a1 1 0 0 0-1-1zm11.15 15h-8.3a1 1 0 0 1-.99-.83L5 8h14l-1.86 11.17a1 1 0 0 1-.99.83M9 4.5a.5.5 0 0 1 .49-.5h5.02a.5.5 0 0 1 .49.5V5H9z"/>'
);
export const EditIcon = makeIcon(
  '<path fill="currentColor" fill-rule="evenodd" d="M4.02 19.23a1 1 0 0 0 1.18 1.18l3.81-.78-4.21-4.21zm5.92-2.62-2.12-2.12L16.31 6l2.12 2.12zm9.9-9.9-2.12-2.12A2 2 0 0 0 16.31 4c-.51 0-1.02.2-1.41.59l-9.76 9.76 4.95 4.95 9.76-9.76a2 2 0 0 0 0-2.83"/>'
);
export const CheckIcon = makeIcon(
  '<path fill="currentColor" d="M6.735 12.322a1 1 0 0 0-1.47 1.356l3.612 3.919c.537.526 1.337.526 1.834.03l.364-.359a2336 2336 0 0 0 3.939-3.883l.04-.04a493 493 0 0 0 3.658-3.643 1 1 0 0 0-1.424-1.404 518 518 0 0 1-3.64 3.625l-.04.04a2049 2049 0 0 1-3.775 3.722z"/>'
);
export const ArrowUpIcon = makeIcon(
  '<path fill="currentColor" fill-rule="evenodd" d="m11.293 5.293-5.5 5.499a1 1 0 0 0 0 1.415 1 1 0 0 0 1.414 0L11 8.414V18a1 1 0 0 0 2 0V8.414l3.793 3.793a1 1 0 1 0 1.414-1.415l-5.5-5.499A1 1 0 0 0 12 5a1 1 0 0 0-.707.293"/>'
);
export const ArrowDownIcon = makeIcon(
  '<path fill="currentColor" fill-rule="evenodd" d="M11 6v9.586l-3.793-3.793a1 1 0 0 0-1.414 0c-.39.39-.39 1.024 0 1.415l5.5 5.499A1 1 0 0 0 12 19a1 1 0 0 0 .707-.293l5.5-5.499a1 1 0 1 0-1.414-1.415L13 15.586V6a1 1 0 0 0-2 0"/>'
);
export const ChevronDownIcon = makeIcon(
  '<path fill="currentColor" fill-rule="evenodd" d="M8.292 10.293a1.01 1.01 0 0 0 0 1.419l2.939 2.965c.218.215.5.322.779.322s.556-.107.769-.322l2.93-2.955a1.01 1.01 0 0 0 0-1.419.987.987 0 0 0-1.406 0l-2.298 2.317-2.307-2.327a.99.99 0 0 0-1.406 0"/>'
);
export const ChevronRightIcon = makeIcon(
  '<path fill="currentColor" fill-rule="evenodd" d="M10.294 9.698a.99.99 0 0 1 0-1.407 1.01 1.01 0 0 1 1.419 0l2.965 2.94a1.09 1.09 0 0 1 0 1.548l-2.955 2.93a1.01 1.01 0 0 1-1.42 0 .99.99 0 0 1 0-1.407l2.318-2.297z"/>'
);
export const VidFullScreenOnIcon = makeIcon(
  '<path fill="currentColor" fill-rule="evenodd" d="M6 18h3a1 1 0 0 1 0 2H6a2 2 0 0 1-2-2v-3a1 1 0 0 1 2 0zm12 2h-3a1 1 0 0 1 0-2h3v-3a1 1 0 0 1 2 0v3a2 2 0 0 1-2 2M6 4h3a1 1 0 1 1 0 2H6v3a1 1 0 1 1-2 0V6a2 2 0 0 1 2-2m12 2h-3a1 1 0 0 1 0-2h3a2 2 0 0 1 2 2v3a1 1 0 0 1-2 0z"/>'
);
export const VidFullScreenOffIcon = makeIcon(
  '<g fill="currentColor" fill-rule="evenodd"><path fill-rule="nonzero" d="M9 15.003v2.995a1 1 0 1 0 2 0v-3.896C11 13.494 10.507 13 9.9 13H6a1 1 0 0 0 0 2.003z"/><path fill-rule="nonzero" d="M3.74 20.294a.997.997 0 0 0 1.407.005l5.152-5.152a1 1 0 0 0-.005-1.407l-.034-.034a.997.997 0 0 0-1.407-.005l-5.152 5.152a1 1 0 0 0 .005 1.407z"/><path d="M19.067 3.321 13.32 9.066a1.115 1.115 0 0 0 .005 1.57l.036.037a1.11 1.11 0 0 0 1.571.005l5.747-5.744a1.116 1.116 0 0 0-.006-1.57l-.037-.037a1.117 1.117 0 0 0-1.57-.006"/><path d="M13 6.002v3.896c0 .608.493 1.102 1.1 1.102H18a1 1 0 0 0 0-2.003h-3V6.002a1 1 0 1 0-2 0"/></g>'
);
