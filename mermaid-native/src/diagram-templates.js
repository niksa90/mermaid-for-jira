// Preset starter source for each diagram type offered when adding a new
// diagram (see App.jsx's template picker). This app has no diagram-type
// whitelist — any type the installed Mermaid can parse already works from
// the source textarea — but each type here was separately confirmed (via a
// jsdom + real-mermaid scratch spike, not committed) to render cleanly
// under this app's htmlLabels:false config with no <foreignObject>/embedded
// HTML leak. Mindmap and architecture-beta were deliberately left out: the
// same spike couldn't get mindmap's canvas-based text-measurement layout to
// complete under jsdom (a jsdom limitation, not a confirmed CSP problem)
// and architecture-beta wasn't checked at all — don't add either without
// running that check first, per the project's "never assume, always
// render and inspect" convention for new diagram types.
export const DIAGRAM_TEMPLATES = [
  {
    id: 'flowchart',
    label: 'Flowchart',
    source: 'flowchart TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Do the thing]\n  B -->|No| D[End]',
  },
  {
    id: 'sequence',
    label: 'Sequence',
    source:
      'sequenceDiagram\n  participant A as Alice\n  participant B as Bob\n  A->>B: Hello Bob, how are you?\n  B-->>A: I am good thanks!',
  },
  {
    id: 'state',
    label: 'State',
    source: 'stateDiagram-v2\n  [*] --> Idle\n  Idle --> Running : start\n  Running --> Idle : stop\n  Running --> [*]',
  },
  {
    id: 'class',
    label: 'Class',
    source:
      'classDiagram\n  Animal <|-- Dog\n  Animal : +String name\n  Animal : +makeSound()\n  class Dog {\n    +fetch()\n  }',
  },
  {
    id: 'er',
    label: 'ER',
    source: 'erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER ||--|{ LINE_ITEM : contains',
  },
  {
    id: 'gantt',
    label: 'Gantt',
    source:
      'gantt\n  title Project Plan\n  dateFormat YYYY-MM-DD\n  section Phase 1\n  Task 1 :a1, 2024-01-01, 14d\n  Task 2 :after a1, 10d',
  },
  {
    id: 'pie',
    label: 'Pie',
    source: 'pie title Distribution\n  "Category A" : 45\n  "Category B" : 35\n  "Category C" : 20',
  },
  {
    id: 'kanban',
    label: 'Kanban',
    source:
      'kanban\n  Todo\n    task1[Write docs]\n    task2[Plan release]\n  Doing\n    task3[Review PR]\n  Done\n    task4[Ship it]',
  },
  {
    id: 'c4',
    label: 'C4 Context',
    source:
      'C4Context\n  Person(user, "User", "A user of the system")\n  System(system, "System", "The main system")\n  Rel(user, system, "Uses")',
  },
];

export function templateById(id) {
  return DIAGRAM_TEMPLATES.find((t) => t.id === id) || null;
}
