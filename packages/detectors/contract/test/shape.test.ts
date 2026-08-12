import { describe, expect, it } from 'vitest';

import { describeShape, parentOf } from '../src/shape.js';

describe('describeShape', () => {
  it('records types and discards values', () => {
    const a = describeShape({ id: 1, name: 'ada' });
    const b = describeShape({ id: 99, name: 'grace' });
    // The entire premise of the detector: two responses that share a shape are
    // the same contract, however different their contents.
    expect(a).toEqual(b);
    expect(a['$.id']).toEqual({ type: 'number' });
    expect(a['$.name']).toEqual({ type: 'string' });
  });

  it('folds every array element onto one path', () => {
    const shape = describeShape({ orders: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    expect(Object.keys(shape)).toEqual(['$', '$.orders', '$.orders[]', '$.orders[].id']);
  });

  it('is unaffected by how many rows the API happened to return', () => {
    const one = describeShape({ orders: [{ id: 1, total: 10 }] });
    const many = describeShape({ orders: [{ id: 1, total: 10 }, { id: 2, total: 20 }] });
    expect(one).toEqual(many);
  });

  it('marks a field optional when only some siblings have it', () => {
    const shape = describeShape({ orders: [{ id: 1, note: 'x' }, { id: 2 }, { id: 3 }] });
    expect(shape['$.orders[].id']).toEqual({ type: 'number' });
    expect(shape['$.orders[].note']).toEqual({ type: 'string', optional: true });
  });

  it('treats a sometimes-null field as nullable rather than as two types', () => {
    const shape = describeShape({ rows: [{ shipped: '2026-01-01' }, { shipped: null }] });
    expect(shape['$.rows[].shipped']).toEqual({ type: 'string', nullable: true });
  });

  it('reports genuinely inconsistent types as mixed', () => {
    const shape = describeShape({ rows: [{ id: 1 }, { id: 'two' }] });
    expect(shape['$.rows[].id']).toEqual({ type: 'mixed' });
  });

  it('describes a bare null without inventing a type', () => {
    expect(describeShape(null)).toEqual({ $: { type: 'null' } });
  });

  it('emits keys in sorted order so the recorded file is stable', () => {
    const first = describeShape({ b: 1, a: 2, c: { z: 1, y: 2 } });
    const second = describeShape({ c: { y: 2, z: 1 }, a: 2, b: 1 });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('handles an empty array without claiming to know its element type', () => {
    const shape = describeShape({ orders: [] });
    expect(shape['$.orders']).toEqual({ type: 'array' });
    expect(shape['$.orders[]']).toBeUndefined();
  });
});

describe('parentOf', () => {
  it('walks up through fields and array elements', () => {
    expect(parentOf('$.orders[].id')).toBe('$.orders[]');
    expect(parentOf('$.orders[]')).toBe('$.orders');
    expect(parentOf('$.orders')).toBe('$');
    expect(parentOf('$')).toBeNull();
  });
});
