import { describe, it, expect } from 'vitest';
import type { ServerResponse } from 'node:http';
import type { SseResponse } from '@dorkos/shared/agent-runtime';

describe('SseResponse type compatibility', () => {
  it('a Node ServerResponse satisfies SseResponse', () => {
    // Type-level assertion — fails at compile time if incompatible
    const _check: SseResponse = {} as ServerResponse;
    expect(true).toBe(true);
  });
});
