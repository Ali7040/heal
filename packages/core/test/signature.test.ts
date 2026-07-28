import { describe, expect, it } from 'vitest';

import { computeSignature, type SignatureInput } from '../src/signature.js';

const base: SignatureInput = {
  detectorId: 'contract',
  kind: 'schema-mismatch',
  location: { endpoint: 'GET /api/users' },
  expected: { id: 'string' },
  actual: { id: 'number' },
};

describe('computeSignature', () => {
  it('is stable across calls', () => {
    expect(computeSignature(base)).toBe(computeSignature(base));
  });

  it('ignores object key order', () => {
    const reordered: SignatureInput = {
      kind: base.kind,
      actual: { id: 'number' },
      detectorId: base.detectorId,
      expected: { id: 'string' },
      location: base.location,
    };
    expect(computeSignature(reordered)).toBe(computeSignature(base));
  });

  it('changes when the measured facts change', () => {
    expect(computeSignature({ ...base, actual: { id: 'boolean' } })).not.toBe(computeSignature(base));
    expect(computeSignature({ ...base, location: { endpoint: 'GET /api/orders' } })).not.toBe(
      computeSignature(base),
    );
  });
});
