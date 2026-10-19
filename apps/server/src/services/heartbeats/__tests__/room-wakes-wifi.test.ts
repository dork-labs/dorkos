/**
 * A room post a person wrote from Wi-Fi wakes no beat when its turn is refused
 * (DOR-3037): a beat runs at the agent's own level, so it would answer the post
 * uncapped. The same post written at this computer still wakes one.
 */
import { describe, expect, it } from 'vitest';
import type { AuthorRegistry } from '../../rooms/author-registry.js';
import { noteEntryHeldToDefault } from '../../core/turn-power/turn-levels.js';
import { shouldWakeForRefusal } from '../room-wakes.js';

const AUTHORS = {
  getMany: (ids: readonly string[]) =>
    new Map(ids.map((id) => [id, { kind: 'human', naturalKey: 'operator' }] as const)),
} as unknown as AuthorRegistry;

const agent = { kind: 'agent' };

/** A person's post that mentions the agent, refused for depth mid-cascade. */
function post(id: string) {
  return { id, authorId: 'owner', cascadeRoot: 'root', sessionId: null };
}

describe('shouldWakeForRefusal', () => {
  it('wakes a beat for a refused post written at this computer', () => {
    expect(shouldWakeForRefusal(agent, 'mention', post('here-1'), 'depth', AUTHORS)).toBe(true);
  });

  it('wakes none for a post written from Wi-Fi', () => {
    noteEntryHeldToDefault('wifi-1');
    expect(shouldWakeForRefusal(agent, 'mention', post('wifi-1'), 'depth', AUTHORS)).toBe(false);
  });
});
