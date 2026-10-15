import { describe, it, expect } from 'vitest';
import { ADDRESS_SEARCH_PARAMS } from '@/layers/shared/lib';
import { sessionSearchSchema } from '@/layers/shared/lib/session-link';
import { channelsSearchSchema } from '../route-search';

describe('ADDRESS_SEARCH_PARAMS (DOR-2824)', () => {
  it('lists only params a route really reads', () => {
    // A typo here would quietly make every link using the real name confirm.
    const read = new Set([
      ...Object.keys(sessionSearchSchema.shape),
      ...Object.keys(channelsSearchSchema.shape),
    ]);
    expect([...ADDRESS_SEARCH_PARAMS].filter((key) => !read.has(key))).toEqual([]);
  });
});
