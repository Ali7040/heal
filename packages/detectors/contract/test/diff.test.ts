import { describe, expect, it } from 'vitest';

import { diffShapes } from '../src/diff.js';
import { describeShape } from '../src/shape.js';

const shapeOf = describeShape;

describe('diffShapes', () => {
  it('reports a field that stopped being returned', () => {
    const drifts = diffShapes(shapeOf({ id: 1, total: 10 }), shapeOf({ id: 1 }));
    expect(drifts).toEqual([{ kind: 'field-missing', path: '$.total', expected: 'number', actual: 'absent' }]);
  });

  it('reports a field whose type changed', () => {
    const drifts = diffShapes(shapeOf({ total: 10 }), shapeOf({ total: '10' }));
    expect(drifts).toEqual([{ kind: 'type-changed', path: '$.total', expected: 'number', actual: 'string' }]);
  });

  it('stays quiet when a new field appears (D-010)', () => {
    // Adding a field does not break a consumer, and a detector that fires on
    // every shipped feature is a detector that gets switched off.
    expect(diffShapes(shapeOf({ id: 1 }), shapeOf({ id: 1, currency: 'usd' }))).toEqual([]);
  });

  it('reports a new field when strict', () => {
    const drifts = diffShapes(shapeOf({ id: 1 }), shapeOf({ id: 1, currency: 'usd' }), { strict: true });
    expect(drifts).toEqual([{ kind: 'field-added', path: '$.currency', expected: 'absent', actual: 'string' }]);
  });

  it('does not report an optional field that is simply absent', () => {
    const recorded = shapeOf({ rows: [{ id: 1, note: 'x' }, { id: 2 }] });
    const observed = shapeOf({ rows: [{ id: 1 }, { id: 2 }] });
    expect(diffShapes(recorded, observed)).toEqual([]);
  });

  it('does not report a nullable field arriving as null', () => {
    const recorded = shapeOf({ rows: [{ shipped: '2026-01-01' }, { shipped: null }] });
    const observed = shapeOf({ rows: [{ shipped: null }] });
    expect(diffShapes(recorded, observed)).toEqual([]);
  });

  it('still reports a non-nullable field arriving as null', () => {
    const drifts = diffShapes(shapeOf({ shipped: '2026-01-01' }), shapeOf({ shipped: null }));
    expect(drifts).toEqual([{ kind: 'type-changed', path: '$.shipped', expected: 'string', actual: 'null' }]);
  });

  it('sorts drifts so the same regression always hashes the same', () => {
    const recorded = shapeOf({ b: 1, a: 1, c: 1 });
    const forward = diffShapes(recorded, shapeOf({}));
    const backward = diffShapes(shapeOf({ c: 1, b: 1, a: 1 }), shapeOf({}));
    expect(forward.map((d) => d.path)).toEqual(['$.a', '$.b', '$.c']);
    expect(forward).toEqual(backward);
  });

  it('finds a field dropped from inside an array', () => {
    const recorded = shapeOf({ orders: [{ id: 1, total: 10 }] });
    const observed = shapeOf({ orders: [{ id: 1 }] });
    expect(diffShapes(recorded, observed)).toEqual([
      { kind: 'field-missing', path: '$.orders[].total', expected: 'number', actual: 'absent' },
    ]);
  });

  it('is silent when nothing changed', () => {
    const body = { orders: [{ id: 1, total: 10, tags: ['a'] }], page: { next: null } };
    expect(diffShapes(shapeOf(body), shapeOf(body))).toEqual([]);
  });
});
