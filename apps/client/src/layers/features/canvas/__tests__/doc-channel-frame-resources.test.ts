import { describe, expect, it } from 'vitest';
import { DocChannelFrameResources } from '../model/doc-channel-frame-resources';

describe('nonissuing frame invalidation tickets', () => {
  it('reserves before abort callbacks and never installs over a nested winner', () => {
    const resources = new DocChannelFrameResources();
    const old = resources.begin();
    let nested = 0;
    let nestedCleanup = 0;
    resources.install(old, () => {
      nested = resources.begin();
      resources.install(nested, () => {
        nestedCleanup++;
      });
    });
    const outer = resources.begin();
    expect(resources.current(outer)).toBe(false);
    expect(resources.current(nested)).toBe(true);
    expect(
      resources.install(outer, () => {
        throw new Error('must never run');
      })
    ).toBe(false);
    expect(nestedCleanup).toBe(0);
    resources.begin();
    expect(nestedCleanup).toBe(1);
  });
  it('drains sibling callbacks after a throw with cleared resources', () => {
    const resources = new DocChannelFrameResources();
    const ticket = resources.begin();
    const calls: string[] = [];
    resources.install(ticket, () => {
      calls.push('resource');
      throw new Error('failed cleanup');
    });
    resources.subscribe(() => {
      calls.push('subscriber1');
      throw new Error('failed subscriber');
    });
    resources.subscribe(() => {
      calls.push('subscriber2');
    });
    const next = resources.begin();
    expect(calls).toEqual(['resource', 'subscriber1', 'subscriber2']);
    expect(resources.current(ticket)).toBe(false);
    expect(resources.current(next)).toBe(true);
  });
});

it('observes a rejected subscriber while a sibling still drains', async () => {
  const resources = new DocChannelFrameResources();
  let drained = 0;
  resources.subscribe(() => Promise.reject(new Error('subscriber rejected')));
  resources.subscribe(() => {
    drained++;
  });
  resources.begin();
  await Promise.resolve();
  expect(drained).toBe(1);
});
