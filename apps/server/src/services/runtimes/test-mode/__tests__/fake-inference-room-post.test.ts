import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';

vi.mock('../../../../env.js', () => ({ env: { DORKOS_TEST_RUNTIME: true } }));

import { createFakeInferenceRouter, roomToPostIn } from '../fake-inference.js';

const ROOM = '01M4MCJ4TMAQ3ASVV3KKDFR1Q3';
const POST_TOOL = { type: 'function', function: { name: 'post_to_room' } };
const ROOM_CONTEXT = { role: 'system', content: `Ids here: this room is ${ROOM}, and…` };

/** The data lines of a streamed completion, parsed. */
function chunks(text: string): Array<{ choices: Array<Record<string, unknown>> }> {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice('data: '.length)));
}

const app = express();
app.use(express.json());
app.use(createFakeInferenceRouter());
const server = listeningServer(app);

describe('the fake inference endpoint in a room', () => {
  it('posts through post_to_room when the turn offers it and names its room', () => {
    expect(
      roomToPostIn({
        tools: [POST_TOOL],
        messages: [ROOM_CONTEXT, { role: 'user', content: 'hi' }],
      })
    ).toBe(ROOM);
  });

  it('ends the turn once this turn has its tool result', () => {
    const messages = [
      ROOM_CONTEXT,
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'ok' },
    ];
    expect(roomToPostIn({ tools: [POST_TOOL], messages })).toBeNull();
  });

  it('posts again on a later turn of the same chat', () => {
    const messages = [
      ROOM_CONTEXT,
      { role: 'user', content: 'first' },
      { role: 'tool', content: 'ok' },
      { role: 'user', content: 'second' },
    ];
    expect(roomToPostIn({ tools: [POST_TOOL], messages })).toBe(ROOM);
  });

  it('streams plain text outside a room', () => {
    expect(roomToPostIn({ messages: [{ role: 'user', content: 'hi' }] })).toBeNull();
    expect(
      roomToPostIn({ tools: [POST_TOOL], messages: [{ role: 'user', content: 'hi' }] })
    ).toBeNull();
  });

  it('streams the reply as a post_to_room call carrying the canned text', async () => {
    const res = await request(server)
      .post('/v1/chat/completions')
      .send({
        model: 'm',
        tools: [POST_TOOL],
        messages: [ROOM_CONTEXT, { role: 'user', content: 'hi' }],
      });
    const call = chunks(res.text)
      .flatMap((chunk) => chunk.choices)
      .map((choice) => (choice.delta as { tool_calls?: unknown[] }).tool_calls)
      .find(Boolean) as Array<{ function: { name: string; arguments: string } }>;
    expect(call[0].function.name).toBe('post_to_room');
    expect(JSON.parse(call[0].function.arguments)).toEqual({
      roomId: ROOM,
      text: 'Hi! I can build that for you.',
    });
  });
});
