/**
 * Smallest common-prefix/suffix diff between two strings: the range in
 * `current` that actually differs from `next`, expressed the way a
 * CodeMirror 6 `changes` spec wants it ({ from, to, insert }).
 *
 * Used by CodeMirrorEditor.jsx to sync an externally-changed value (e.g.
 * the node-style popover editing the same diagram's source) into the
 * editor without replacing the whole document — a full-document replace
 * discards the cursor's actual position, forcing CodeMirror to treat the
 * selection as having jumped and scroll to "reveal" it, even when the
 * edit landed nowhere near where the user was looking. A targeted change
 * over just the differing range lets CodeMirror's normal selection
 * mapping carry the existing cursor through untouched whenever the edit
 * is elsewhere in the document.
 *
 * Not a general-purpose (LCS-style) diff — just enough to skip the
 * unchanged head/tail, which is exactly what this call site needs and
 * cheap enough to run on every keystroke.
 */
export function diffRange(current, next) {
  let prefixLen = 0;
  const maxPrefix = Math.min(current.length, next.length);
  while (prefixLen < maxPrefix && current[prefixLen] === next[prefixLen]) prefixLen++;

  let suffixLen = 0;
  const maxSuffix = Math.min(current.length, next.length) - prefixLen;
  while (
    suffixLen < maxSuffix &&
    current[current.length - 1 - suffixLen] === next[next.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  return {
    from: prefixLen,
    to: current.length - suffixLen,
    insert: next.slice(prefixLen, next.length - suffixLen),
  };
}
