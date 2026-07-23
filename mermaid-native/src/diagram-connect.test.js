import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isConnectable,
  resolveConnectKind,
  connectNodes,
  deleteFlowchartEdge,
  readFlowchartEdgeLabel,
  setFlowchartEdgeLabel,
  deleteStateEdge,
  readStateEdgeAtIndex,
  setStateEdgeLabelAtIndex,
  parseClassIds,
  readClassEdge,
  deleteClassEdge,
  setClassEdge,
  readErEdge,
  deleteErEdge,
  setErEdge,
  parseSequenceMessages,
  readSequenceMessageAtIndex,
  setSequenceMessageAtIndex,
  deleteSequenceMessageAtIndex,
} from './diagram-connect.js';

test('isConnectable recognizes flowchart and graph, ignoring a leading %%init directive', () => {
  assert.equal(isConnectable('flowchart TD\n  A --> B'), true);
  assert.equal(isConnectable('graph LR\n  A --> B'), true);
  assert.equal(isConnectable('%%{init: {"theme": "dark"}}%%\nflowchart TD\n  A --> B'), true);
});

test('isConnectable is true for flowchart, state, class, ER, and sequence', () => {
  assert.equal(isConnectable('stateDiagram-v2\n  [*] --> A'), true);
  assert.equal(isConnectable('classDiagram\n  class A'), true);
  assert.equal(isConnectable('erDiagram\n  A ||--o{ B : has'), true);
  assert.equal(isConnectable('sequenceDiagram\n  A->>B: hi'), true);
  assert.equal(isConnectable(''), false);
});

test('resolveConnectKind reports arrow options only for class/ER, and needsLabel only for ER', () => {
  assert.equal(resolveConnectKind('flowchart TD\n  A-->B').arrowOptions, null);
  assert.equal(resolveConnectKind('stateDiagram-v2\n  [*] --> A').arrowOptions, null);
  assert.ok(resolveConnectKind('classDiagram\n  class A').arrowOptions.length > 0);
  assert.ok(resolveConnectKind('erDiagram\n  A ||--o{ B : has').arrowOptions.length > 0);
  assert.equal(resolveConnectKind('erDiagram\n  A ||--o{ B : has').needsLabel, true);
  assert.equal(resolveConnectKind('classDiagram\n  class A').needsLabel, false);
});

test('connectNodes appends a plain arrow between the two given ids for flowchart', () => {
  const source = 'flowchart TD\n  A[Start]\n  B[Process]';
  assert.equal(connectNodes(source, 'A', 'B'), 'flowchart TD\n  A[Start]\n  B[Process]\nA --> B');
});

test('connectNodes appends a plain transition for state diagrams', () => {
  const source = 'stateDiagram-v2\n  A\n  B';
  assert.equal(connectNodes(source, 'A', 'B'), 'stateDiagram-v2\n  A\n  B\nA --> B');
});

test('connectNodes translates the root_start/root_end pseudostate ids back to [*]', () => {
  const source = 'stateDiagram-v2\n  [*] --> A';
  assert.equal(connectNodes(source, 'root_start', 'B'), 'stateDiagram-v2\n  [*] --> A\n[*] --> B');
  assert.equal(connectNodes(source, 'A', 'root_end'), 'stateDiagram-v2\n  [*] --> A\nA --> [*]');
});

test('connectNodes uses the default association arrow for class diagrams, or a chosen one', () => {
  const source = 'classDiagram\n  class A\n  class B';
  assert.equal(connectNodes(source, 'A', 'B'), 'classDiagram\n  class A\n  class B\nA --> B');
  assert.equal(
    connectNodes(source, 'A', 'B', { arrowId: 'inheritance' }),
    'classDiagram\n  class A\n  class B\nA <|-- B'
  );
});

test('connectNodes always includes a quoted label for ER (mandatory in Mermaid syntax, and unquoted multi-word labels fail to parse), defaulting to a placeholder', () => {
  const source = 'erDiagram\n  A\n  B';
  assert.equal(connectNodes(source, 'A', 'B'), 'erDiagram\n  A\n  B\nA ||--o{ B : "relates to"');
  assert.equal(
    connectNodes(source, 'A', 'B', { arrowId: 'one-to-one', label: 'owns' }),
    'erDiagram\n  A\n  B\nA ||--|| B : "owns"'
  );
});

test('connectNodes is a no-op for a self-connection, missing ids, or an unsupported diagram type', () => {
  assert.equal(connectNodes('flowchart TD\n  A[Start]', 'A', 'A'), 'flowchart TD\n  A[Start]');
  assert.equal(connectNodes('flowchart TD\n  A[Start]', '', 'A'), 'flowchart TD\n  A[Start]');
  assert.equal(connectNodes('pie\n  "A" : 10', 'A', 'B'), 'pie\n  "A" : 10');
});

test('deleteFlowchartEdge removes a bare edge line entirely', () => {
  const source = 'flowchart TD\n  A --> B\n  B --> C';
  assert.equal(deleteFlowchartEdge(source, 'A', 'B'), 'flowchart TD\n  B --> C');
});

// The app's own default new-diagram template combines a node declaration
// with its edge on one line — deleting the edge must not also discard the
// shape/label that happened to share the line with it.
test('deleteFlowchartEdge splits a combined declaration+edge line, preserving both shapes', () => {
  const source = 'flowchart TD\n  A[Start] --> B[End]';
  assert.equal(deleteFlowchartEdge(source, 'A', 'B'), 'flowchart TD\nA[Start]\nB[End]');
});

test('deleteFlowchartEdge preserves only the side(s) that actually had a shape on that line', () => {
  const source = 'flowchart TD\n  B -->|Yes| C[Do the thing]';
  assert.equal(deleteFlowchartEdge(source, 'B', 'C'), 'flowchart TD\nC[Do the thing]');
});

test('deleteFlowchartEdge is a no-op when no line is exactly that edge (e.g. a chained arrow line)', () => {
  const source = 'flowchart TD\n  A --> B --> C';
  assert.equal(deleteFlowchartEdge(source, 'A', 'B'), source);
});

test('deleteFlowchartEdge is a no-op if the edge does not exist', () => {
  const source = 'flowchart TD\n  A --> B';
  assert.equal(deleteFlowchartEdge(source, 'A', 'C'), source);
});

test('deleteStateEdge removes the Nth transition line in source order (0-based)', () => {
  const source = 'stateDiagram-v2\n  [*] --> A\n  A --> B\n  B --> A';
  assert.equal(deleteStateEdge(source, 1), 'stateDiagram-v2\n  [*] --> A\n  B --> A');
  assert.equal(deleteStateEdge(source, 0), 'stateDiagram-v2\n  A --> B\n  B --> A');
});

test('deleteStateEdge is a no-op for an out-of-range or missing index', () => {
  const source = 'stateDiagram-v2\n  A --> B';
  assert.equal(deleteStateEdge(source, 5), source);
  assert.equal(deleteStateEdge(source, null), source);
});

test('parseClassIds finds declared classes and relationship endpoints', () => {
  const source = 'classDiagram\n  class Animal\n  class Dog\n  Animal <|-- Dog';
  assert.deepEqual(parseClassIds(source).sort(), ['Animal', 'Dog']);
});

test('readClassEdge / deleteClassEdge / setClassEdge round-trip a class relationship', () => {
  const source = 'classDiagram\n  class Animal\n  class Dog\n  Animal <|-- Dog';
  assert.deepEqual(readClassEdge(source, 'Animal', 'Dog'), { arrowId: 'inheritance', label: '' });
  assert.equal(deleteClassEdge(source, 'Animal', 'Dog'), 'classDiagram\n  class Animal\n  class Dog');
  assert.equal(
    setClassEdge(source, 'Animal', 'Dog', 'composition', 'has-a'),
    'classDiagram\n  class Animal\n  class Dog\nAnimal *-- Dog : has-a'
  );
});

test('readErEdge / deleteErEdge / setErEdge round-trip an ER relationship, reading both bare and quoted labels', () => {
  const source = 'erDiagram\n  CUSTOMER ||--o{ ORDER : places';
  assert.deepEqual(readErEdge(source, 'CUSTOMER', 'ORDER'), { arrowId: 'one-to-many', label: 'places' });
  assert.equal(deleteErEdge(source, 'CUSTOMER', 'ORDER'), 'erDiagram');

  const quotedSource = 'erDiagram\n  CUSTOMER ||--o{ ORDER : "places an order"';
  assert.deepEqual(readErEdge(quotedSource, 'CUSTOMER', 'ORDER'), {
    arrowId: 'one-to-many',
    label: 'places an order',
  });
});

// ER relationships require a label to parse at all, and a multi-word label
// fails unless quoted (confirmed via the real parser) — setErEdge always
// quotes, unlike setClassEdge, and never falls back to a default: an empty
// quoted label (`: ""`) is itself valid syntax, so a cleared field is
// respected rather than snapped back to a placeholder mid-edit.
test('setErEdge always quotes the label, including a multi-word one, and respects an intentionally cleared label', () => {
  const source = 'erDiagram\n  CUSTOMER ||--o{ ORDER : places';
  assert.equal(
    setErEdge(source, 'CUSTOMER', 'ORDER', 'one-to-one', 'owns many things'),
    'erDiagram\nCUSTOMER ||--|| ORDER : "owns many things"'
  );
  assert.equal(setErEdge(source, 'CUSTOMER', 'ORDER', 'one-to-one', ''), 'erDiagram\nCUSTOMER ||--|| ORDER : ""');
});

test('readFlowchartEdgeLabel / setFlowchartEdgeLabel round-trip a flowchart edge label, preserving shapes and arrow style', () => {
  const source = 'flowchart TD\n  A[Start] --> B[End]';
  assert.equal(readFlowchartEdgeLabel(source, 'A', 'B'), '');
  const labeled = setFlowchartEdgeLabel(source, 'A', 'B', 'go now');
  assert.equal(labeled, 'flowchart TD\nA[Start] -->|go now| B[End]');
  assert.equal(readFlowchartEdgeLabel(labeled, 'A', 'B'), 'go now');
  assert.equal(setFlowchartEdgeLabel(labeled, 'A', 'B', ''), 'flowchart TD\nA[Start] --> B[End]');
});

test('setFlowchartEdgeLabel preserves a non-default arrow style (dotted, thick, ...)', () => {
  const source = 'flowchart TD\n  A -.->|maybe| B';
  assert.equal(setFlowchartEdgeLabel(source, 'A', 'B', 'changed'), 'flowchart TD\nA -.->|changed| B');
});

test('readFlowchartEdgeLabel returns null for a chained arrow line it does not fully recognize', () => {
  assert.equal(readFlowchartEdgeLabel('flowchart TD\n  A --> B --> C', 'A', 'B'), null);
});

test('readStateEdgeAtIndex / setStateEdgeLabelAtIndex round-trip a state transition label positionally', () => {
  const source = 'stateDiagram-v2\n  [*] --> A\n  A --> B : go\n  B --> A';
  assert.deepEqual(readStateEdgeAtIndex(source, 1), { fromId: 'A', toId: 'B', label: 'go' });
  assert.equal(
    setStateEdgeLabelAtIndex(source, 0, 'hi'),
    'stateDiagram-v2\n[*] --> A : hi\n  A --> B : go\n  B --> A'
  );
  assert.equal(setStateEdgeLabelAtIndex(source, 1, ''), 'stateDiagram-v2\n  [*] --> A\nA --> B\n  B --> A');
});

test('readStateEdgeAtIndex returns null for an out-of-range index', () => {
  assert.equal(readStateEdgeAtIndex('stateDiagram-v2\n  A --> B', 5), null);
});

test('resolveConnectKind reports the 8 sequence arrow variants and a solid-arrow default, no required label', () => {
  const kind = resolveConnectKind('sequenceDiagram\n  A->>B: hi');
  assert.equal(kind.arrowOptions.length, 8);
  assert.equal(kind.defaultArrowId, 'solid-arrow');
  assert.equal(kind.needsLabel, false);
});

test('connectNodes appends a solid-arrow message with a placeholder label for sequence diagrams', () => {
  const source = 'sequenceDiagram\n  participant A\n  participant B';
  assert.equal(
    connectNodes(source, 'A', 'B'),
    'sequenceDiagram\n  participant A\n  participant B\nA->>B: message'
  );
});

test('parseSequenceMessages finds message lines top to bottom, ignoring participant/loop/alt/end keyword lines but including messages nested inside them', () => {
  const source = [
    'sequenceDiagram',
    '  participant A',
    '  participant B',
    '  A->>B: one',
    '  loop Every message',
    '    B-->>A: two',
    '  end',
    '  alt condition',
    '    A-)B: three',
    '  else',
    '    A-xB: four',
    '  end',
  ].join('\n');
  const messages = parseSequenceMessages(source);
  assert.deepEqual(
    messages.map((m) => ({ fromId: m.fromId, toId: m.toId, arrowSyntax: m.arrowSyntax, label: m.label })),
    [
      { fromId: 'A', toId: 'B', arrowSyntax: '->>', label: 'one' },
      { fromId: 'B', toId: 'A', arrowSyntax: '-->>', label: 'two' },
      { fromId: 'A', toId: 'B', arrowSyntax: '-)', label: 'three' },
      { fromId: 'A', toId: 'B', arrowSyntax: '-x', label: 'four' },
    ]
  );
});

test('readSequenceMessageAtIndex / setSequenceMessageAtIndex / deleteSequenceMessageAtIndex round-trip a message positionally, disambiguating duplicate (from, to) pairs', () => {
  const source = 'sequenceDiagram\n  A->>B: one\n  A->>B: two\n  B-->>A: reply';
  assert.deepEqual(readSequenceMessageAtIndex(source, 0), { fromId: 'A', toId: 'B', label: 'one', arrowId: 'solid-arrow' });
  assert.deepEqual(readSequenceMessageAtIndex(source, 1), { fromId: 'A', toId: 'B', label: 'two', arrowId: 'solid-arrow' });

  const relabeled = setSequenceMessageAtIndex(source, 1, 'solid-arrow', 'two (edited)');
  assert.equal(relabeled, 'sequenceDiagram\n  A->>B: one\n  A->>B: two (edited)\n  B-->>A: reply');
  // Index 0's identical (from, to) pair is untouched by editing index 1.
  assert.deepEqual(readSequenceMessageAtIndex(relabeled, 0), { fromId: 'A', toId: 'B', label: 'one', arrowId: 'solid-arrow' });

  const restyled = setSequenceMessageAtIndex(source, 2, 'dotted-cross', 'reply (edited)');
  assert.equal(restyled, 'sequenceDiagram\n  A->>B: one\n  A->>B: two\n  B--xA: reply (edited)');

  assert.equal(deleteSequenceMessageAtIndex(source, 1), 'sequenceDiagram\n  A->>B: one\n  B-->>A: reply');
});

test('setSequenceMessageAtIndex preserves the message line\'s own leading indentation (e.g. inside a loop/alt block)', () => {
  const source = 'sequenceDiagram\n  loop Every message\n    A->>B: check\n  end';
  assert.equal(
    setSequenceMessageAtIndex(source, 0, 'solid-arrow', 'check again'),
    'sequenceDiagram\n  loop Every message\n    A->>B: check again\n  end'
  );
});

test('readSequenceMessageAtIndex / deleteSequenceMessageAtIndex are no-ops/null for an out-of-range ordinal', () => {
  const source = 'sequenceDiagram\n  A->>B: hi';
  assert.equal(readSequenceMessageAtIndex(source, 5), null);
  assert.equal(deleteSequenceMessageAtIndex(source, 5), source);
});
