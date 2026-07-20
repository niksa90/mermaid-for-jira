function sectionOf(diagram) {
  return (diagram.section || '').trim();
}

/**
 * Groups diagrams by their `section` field for rendering, without changing
 * how they're stored — `diagrams` stays a flat array (order = real,
 * persisted content), grouping is purely a render-time view over it. A
 * diagram with no section renders standalone; diagrams sharing a section
 * name are clustered together the first time that name appears, regardless
 * of where else in the array a same-named diagram shows up later.
 */
export function buildRenderGroups(diagramsArr) {
  const groups = [];
  const sectionAt = new Map();
  diagramsArr.forEach((diagram, index) => {
    const section = sectionOf(diagram);
    if (!section) {
      groups.push({ type: 'standalone', diagram, index });
      return;
    }
    if (sectionAt.has(section)) {
      groups[sectionAt.get(section)].items.push({ diagram, index });
    } else {
      sectionAt.set(section, groups.length);
      groups.push({ type: 'section', name: section, items: [{ diagram, index }] });
    }
  });
  return groups;
}

function memberIndices(diagramsArr, section) {
  const indices = [];
  diagramsArr.forEach((d, i) => {
    if (sectionOf(d) === section) indices.push(i);
  });
  return indices;
}

/**
 * Flat-array index a diagram should swap with when moved up (direction -1)
 * or down (direction 1). A sectioned diagram only ever swaps with its
 * nearest same-section neighbor — whatever else sits between them in the
 * flat array is left untouched — so the move always stays within the
 * diagram's own group instead of the old behavior of swapping with
 * whatever happened to be flat-adjacent (which could belong to a different
 * section or no section at all). Returns null if the diagram is already at
 * the boundary of its group (or, for an unsectioned diagram, of the list).
 */
export function moveTargetIndex(diagramsArr, id, direction) {
  const index = diagramsArr.findIndex((d) => d.id === id);
  if (index === -1) return null;
  const section = sectionOf(diagramsArr[index]);

  if (!section) {
    const target = index + direction;
    return target >= 0 && target < diagramsArr.length ? target : null;
  }

  const indices = memberIndices(diagramsArr, section);
  const posInGroup = indices.indexOf(index);
  const targetPos = posInGroup + direction;
  return targetPos >= 0 && targetPos < indices.length ? indices[targetPos] : null;
}

/** Whether a diagram can move up/down, relative to its own group. */
export function moveBounds(diagramsArr, id) {
  const index = diagramsArr.findIndex((d) => d.id === id);
  if (index === -1) return { canUp: false, canDown: false };
  const section = sectionOf(diagramsArr[index]);

  if (!section) {
    return { canUp: index > 0, canDown: index < diagramsArr.length - 1 };
  }

  const indices = memberIndices(diagramsArr, section);
  const posInGroup = indices.indexOf(index);
  return { canUp: posInGroup > 0, canDown: posInGroup < indices.length - 1 };
}
