import { describe, expect, it } from 'vitest';
import { cloudFailure } from '../cloud-failure';

describe('cloudFailure', () => {
  it.each([
    ['cloud_link_required', 'relink'],
    ['cloud_link_needs_update', 'relink'],
    ['cloud_unavailable', undefined],
    ['cloud_refused', undefined],
  ])('gives %s its own copy, offering a relink only for a link problem', (code, action) => {
    const failure = cloudFailure(Object.assign(new Error('x'), { code }));
    expect(failure).not.toBeNull();
    expect(failure!.title.length).toBeGreaterThan(0);
    expect(failure!.description.length).toBeGreaterThan(0);
    expect(failure!.action).toBe(action);
  });

  it('keeps the surface’s own copy for any other error', () => {
    expect(cloudFailure(Object.assign(new Error('x'), { code: 'actions_unavailable' }))).toBeNull();
    expect(cloudFailure(new Error('offline'))).toBeNull();
    expect(cloudFailure(undefined)).toBeNull();
    expect(cloudFailure('cloud_refused')).toBeNull();
  });
});
