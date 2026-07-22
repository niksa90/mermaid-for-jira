import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isERDiagramSource, parseERIds, parseERStyles, upsertERStyle } from './er-style.js';

test('isERDiagramSource recognizes erDiagram', () => {
  assert.equal(isERDiagramSource('erDiagram\n  A ||--o{ B : has'), true);
  assert.equal(isERDiagramSource('flowchart TD\n  A --> B'), false);
});

test('parseERIds finds both endpoints of relationship lines regardless of cardinality', () => {
  const source = [
    'erDiagram',
    'CUSTOMER ||--o{ ORDER : places',
    'ORDER ||--|{ LINE_ITEM : contains',
    'ORDER }o--|| SHIPPER : uses',
  ].join('\n');
  const ids = parseERIds(source);
  assert.deepEqual(ids, ['CUSTOMER', 'LINE_ITEM', 'ORDER', 'SHIPPER']);
});

test('parseERIds finds standalone attribute-block entity declarations', () => {
  const source = ['erDiagram', 'CUSTOMER {', '  string name', '}'].join('\n');
  assert.deepEqual(parseERIds(source), ['CUSTOMER']);
});

test('parseERIds excludes reserved keywords', () => {
  const ids = parseERIds('erDiagram\nCUSTOMER ||--o{ ORDER : places');
  assert.ok(!ids.includes('erDiagram'));
});

test('upsertERStyle creates a classDef + class pair when neither exists', () => {
  const source = 'erDiagram\nCUSTOMER ||--o{ ORDER : places';
  const next = upsertERStyle(source, 'CUSTOMER', { fill: '#f00' });
  assert.equal(
    next,
    'erDiagram\nCUSTOMER ||--o{ ORDER : places\nclassDef nodeStyle_CUSTOMER fill:#f00\nclass CUSTOMER nodeStyle_CUSTOMER'
  );
});

test("parseERStyles reads back only this picker's own dedicated classDefs", () => {
  const source = [
    'erDiagram',
    'CUSTOMER ||--o{ ORDER : places',
    'classDef nodeStyle_CUSTOMER fill:#f00,stroke:#333',
    'class CUSTOMER nodeStyle_CUSTOMER',
    'classDef someHandwrittenClass fill:#0f0',
    'class CUSTOMER someHandwrittenClass',
  ].join('\n');
  assert.deepEqual(parseERStyles(source), { CUSTOMER: { fill: '#f00', stroke: '#333' } });
});

test('upsertERStyle merges into the existing pair without touching other hand-written classes', () => {
  const source = [
    'erDiagram',
    'CUSTOMER ||--o{ ORDER : places',
    'classDef nodeStyle_CUSTOMER fill:#f00',
    'class CUSTOMER nodeStyle_CUSTOMER',
    'classDef someHandwrittenClass fill:#0f0',
    'class CUSTOMER someHandwrittenClass',
  ].join('\n');
  const next = upsertERStyle(source, 'CUSTOMER', { stroke: '#333' });
  assert.ok(next.includes('classDef nodeStyle_CUSTOMER fill:#f00,stroke:#333'));
  assert.ok(next.includes('classDef someHandwrittenClass fill:#0f0'));
  assert.ok(next.includes('class CUSTOMER someHandwrittenClass'));
});

test('upsertERStyle removes both lines once every channel is cleared', () => {
  const source = [
    'erDiagram',
    'CUSTOMER ||--o{ ORDER : places',
    'classDef nodeStyle_CUSTOMER fill:#f00,stroke:#333',
    'class CUSTOMER nodeStyle_CUSTOMER',
  ].join('\n');
  const next = upsertERStyle(source, 'CUSTOMER', { fill: '', stroke: '' });
  assert.equal(next, 'erDiagram\nCUSTOMER ||--o{ ORDER : places');
});

// The classDef/class syntax's validity against the real Mermaid parser, and
// the fact that it renders as an inline `style="...!important"` attribute
// directly on the entity's <rect> (a different rendered-output path from
// state diagrams' CSS-class-rule <style> block, despite sharing the same
// classDef/class *source* syntax), was checked manually via a jsdom
// scratch render — see the click-to-style-plan project memory. `mermaid` is
// only a dependency of the inner static/main-custom-ui package, not this
// outer one `npm test` runs from, so it can't be cross-imported here,
// matching state-style.test.js's own note on this.
