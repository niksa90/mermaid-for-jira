// Dispatches to the right diagram-type-specific style module for whichever
// per-node/state/entity color styling mechanism a diagram's source actually
// uses. Shared by the docked node-style dropdown and the click-on-the-bubble
// popover (App.jsx) so both entry points read/write through the exact same
// parse/upsert logic per diagram type rather than duplicating the dispatch.
//
// Only flowchart, state, and ER diagrams have any per-element style
// mechanism at all — verified against the real Mermaid parser, not assumed
// (see CLAUDE.md's CSP section and the click-to-style-plan project memory).
// Sequence/pie/gantt/kanban/mindmap return null here; callers should treat
// that as "this diagram type has nothing to offer a style picker for".
import { isFlowchartSource, parseFlowchartNodeIds, parseNodeStyles, upsertNodeStyle } from './node-style.js';
import { isStateDiagramSource, parseStateIds, parseStateStyles, upsertStateStyle } from './state-style.js';
import { isERDiagramSource, parseERIds, parseERStyles, upsertERStyle } from './er-style.js';

export function resolveNodeStyleKind(source) {
  if (isFlowchartSource(source)) {
    return {
      kind: 'flowchart',
      parseIds: parseFlowchartNodeIds,
      parseStyles: parseNodeStyles,
      upsertStyle: upsertNodeStyle,
    };
  }
  if (isStateDiagramSource(source)) {
    return {
      kind: 'state',
      parseIds: parseStateIds,
      parseStyles: parseStateStyles,
      upsertStyle: upsertStateStyle,
    };
  }
  if (isERDiagramSource(source)) {
    return {
      kind: 'er',
      parseIds: parseERIds,
      parseStyles: parseERStyles,
      upsertStyle: upsertERStyle,
    };
  }
  return null;
}
