/**
 * The to-do card (DOR-3088, Security's Must 2 and G3): only the server writes one, in the room's
 * own voice, waking nobody; a post can never carry one in.
 */
import { describe, expect, it } from 'vitest';
import { PostToRoomRequestSchema } from '@dorkos/shared/room-schemas';
import { agentLookupFor, createRoomHarness, scriptedRunner } from './room-test-harness.js';

const AGENTS = agentLookupFor({ '/agents/ana': { name: 'ana' } });

function directChat() {
  const runner = scriptedRunner(() => 'on it');
  const harness = createRoomHarness({ agents: AGENTS, runner });
  const room = harness.service.createRoom(
    { kind: 'dm', title: 'ana', members: [], agentPaths: ['/agents/ana'] },
    harness.human
  );
  return { ...harness, runner, room };
}

describe('the to-do card', () => {
  it("is written in the room's own voice, addresses nobody, and starts no turn", async () => {
    const { service, runner, room, human } = directChat();
    const card = service.postTodoCard(room.id, { text: 'New to-do', todoId: 'todo-1' });
    await service.triggersIdle();
    expect(card.body).toEqual({ text: 'New to-do', todo: { todoId: 'todo-1' } });
    expect(card.mentions).toEqual([]);
    expect(runner.turns).toEqual([]);
    const stored = service.listEntries(room.id, human, { limit: 10 }).at(-1);
    expect(stored?.body.todo).toEqual({ todoId: 'todo-1' });
  });

  it('is never carried in by a post: a request body drops it, and so does the writer', async () => {
    const parsed = PostToRoomRequestSchema.parse({ text: 'hi', todo: { todoId: 'todo-1' } });
    expect(parsed).not.toHaveProperty('todo');

    const { service, room, human } = directChat();
    const entry = service.post(room.id, {
      authorId: human,
      text: 'hi',
      // A caller that slipped the field past its schema still writes no card.
      ...({ todo: { todoId: 'todo-1' } } as object),
    });
    await service.triggersIdle();
    expect(entry.body).not.toHaveProperty('todo');
  });
});
