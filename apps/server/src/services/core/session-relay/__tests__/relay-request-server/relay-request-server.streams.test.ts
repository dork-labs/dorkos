/**
 * @vitest-environment node
 *
 * The relayed caller's adapter: interrupts, refused approvals and answers,
 * the per-connection limits, the stream's framing and teardown, and the audit
 * entry for each op.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  RelayResultBodySchemas,
  SESSION_RELAY_MAX_INFLIGHT_REQUESTS,
  SESSION_RELAY_MAX_OPEN_STREAMS,
} from '@dorkos/shared/session-relay';
import type { StreamFrame } from '@dorkos/shared/stream-socket';
import { AGENT_ID, CHAT, facts, harness } from './relay-request-server.fixtures.js';

describe('SessionRelayRequestServer', () => {
  it('interrupts like the Stop button: the queue, then the turn', async () => {
    const h = harness();
    h.runtime.interruptQuery.mockRejectedValueOnce(new Error('boom'));
    h.send('i', { op: 'session.interrupt', sessionId: CHAT });
    await h.settle();
    const body = RelayResultBodySchemas['session.interrupt'].parse(
      (h.answerTo('i') as { body: unknown }).body
    );
    expect(body.receipt).toEqual({
      outcome: 'failed',
      reason: 'delivery-failed',
      runtime: 'claude-code',
    });
    expect(body.cancelledQueued).toHaveLength(1);
    expect(h.deps.clearQueuedMessages).toHaveBeenCalledWith(CHAT);
  });

  describe('interactions', () => {
    it('refuses every answer to a question, and never answers one', async () => {
      const h = harness();
      h.send('q', {
        op: 'interaction.respond',
        sessionId: CHAT,
        answer: { kind: 'answer', toolCallId: 't1', answers: { '0': 'Blue' } },
      });
      await h.settle();
      expect(h.answerTo('q')).toEqual({
        type: 'error',
        id: 'q',
        ok: false,
        error: {
          status: 403,
          code: 'refused',
          message: 'Answers from the web need a newer version of this computer.',
        },
      });
      expect(h.runtime.submitAnswers).not.toHaveBeenCalled();
      expect(h.deps.resolveRuntime).not.toHaveBeenCalled();
      expect(h.audits.at(-1)).toMatchObject({
        action: 'relay.interaction.respond',
        outcome: 'refused',
        target: { type: 'session', id: CHAT },
      });
    });

    it('with no passkey pinned, refuses every approval and challenge, and never approves a tool', async () => {
      const h = harness();
      const proof = {
        challengeId: 'c1',
        credentialId: 'AA',
        clientDataJSON: 'AA',
        authenticatorData: 'AA',
        signature: 'AA',
      };
      h.send('a', {
        op: 'interaction.respond',
        sessionId: CHAT,
        answer: { kind: 'approve', toolCallId: 't', proof },
      });
      h.send('d', {
        op: 'interaction.respond',
        sessionId: CHAT,
        answer: { kind: 'deny', toolCallId: 't', proof },
      });
      h.send('c', {
        op: 'interaction.challenge',
        sessionId: CHAT,
        toolCallId: 't',
        decision: 'approve',
      });
      await h.settle();
      for (const id of ['a', 'd', 'c']) {
        expect(h.answerTo(id)).toEqual({
          type: 'error',
          id,
          ok: false,
          error: {
            status: 403,
            code: 'refused',
            message: 'Add a passkey at this computer to approve from the web.',
          },
        });
      }
      expect(h.deps.approveTool).not.toHaveBeenCalled();
      expect(h.audits.filter((a) => a.action === 'relay.interaction.approval')).toHaveLength(2);
      expect(h.audits.filter((a) => a.action === 'relay.interaction.challenge')).toHaveLength(1);
    });
  });

  describe('limits and failures', () => {
    it('refuses past the unanswered-request limit', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const h = harness({
        deps: {
          locateSession: vi.fn(async () => {
            await gate;
            return facts(CHAT);
          }),
        },
      });
      for (let n = 0; n <= SESSION_RELAY_MAX_INFLIGHT_REQUESTS; n++) {
        h.send(`r${n}`, { op: 'session.interrupt', sessionId: CHAT });
      }
      expect(h.answerTo(`r${SESSION_RELAY_MAX_INFLIGHT_REQUESTS}`)).toMatchObject({
        ok: false,
        error: { status: 429, code: 'rate_limited' },
      });
      release();
      await h.settle();
      await h.settle();
      h.send('after', { op: 'session.interrupt', sessionId: CHAT });
      await h.settle();
      expect(h.answerTo('after')).toMatchObject({ ok: true });
    });

    it('refuses past the open-stream limit', async () => {
      const h = harness();
      for (let n = 0; n < SESSION_RELAY_MAX_OPEN_STREAMS; n++) {
        h.send(`s${n}`, { op: 'session.stream', streamId: `st${n}`, sessionId: CHAT });
        await h.settle();
      }
      h.send('over', { op: 'session.stream', streamId: 'over', sessionId: CHAT });
      expect(h.frames.at(-1)).toMatchObject({
        type: 'stream.end',
        streamId: 'over',
        error: { status: 429, code: 'rate_limited' },
      });
    });

    it('answers an internal failure with a plain 500 that leaks nothing', async () => {
      const h = harness({
        deps: {
          locateSession: vi.fn(async () => {
            throw new Error('ENOENT /Users/secret/.claude/projects');
          }),
        },
      });
      h.send('i', { op: 'session.interrupt', sessionId: CHAT });
      await h.settle();
      expect(h.answerTo('i')).toEqual({
        type: 'error',
        id: 'i',
        ok: false,
        error: { status: 500, code: 'internal', message: 'Something went wrong on this computer.' },
      });
      expect(h.audits.at(-1)).toMatchObject({ outcome: 'failed' });
    });

    it('refuses a frame that is not a request it knows', async () => {
      const h = harness();
      h.send('x', { op: 'session.terminal', sessionId: CHAT });
      await h.settle();
      expect(h.answerTo('x')).toMatchObject({ ok: false, error: { status: 400, code: 'invalid' } });
    });
  });

  describe('session.stream', () => {
    it('streams frames as the relayed caller, resuming from the cursor', async () => {
      const h = harness();
      const cursor = `${CHAT}-1700000000000-g1-7`;
      h.send('s', { op: 'session.stream', streamId: 'st', sessionId: CHAT, resume: cursor });
      await h.settle();
      expect(h.deps.resolveStreamPlan).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: CHAT }),
        cursor
      );
      const [{ sink, plan }] = h.streams;
      expect(plan.principal).toEqual({ kind: 'relayed' });
      expect(plan.resume).toEqual({ seq: 7, generation: 'g1' });
      const frame: StreamFrame = {
        event: 'text_delta',
        data: { text: 'hi' },
        id: `${CHAT}-1-g1-8`,
      };
      await sink!.send(frame);
      await sink!.send({ event: 'snapshot', data: { messages: [] } });
      expect(h.frames).toEqual([
        { type: 'stream.frame', streamId: 'st', frame },
        {
          type: 'stream.frame',
          streamId: 'st',
          frame: { event: 'snapshot', data: { messages: [] } },
        },
      ]);
      expect(h.audits.map((a) => a.action)).toEqual(['relay.session.stream']);
    });

    it('ends on stream.close, once, and frees the slot', async () => {
      const h = harness();
      h.send('s', { op: 'session.stream', streamId: 'st', sessionId: CHAT });
      await h.settle();
      h.server.handle({ type: 'stream.close', streamId: 'st' }, h.emit);
      await h.settle();
      expect(h.streams[0]!.sink.closed).toBe(true);
      expect(h.frames.filter((f) => f.type === 'stream.end')).toEqual([
        { type: 'stream.end', streamId: 'st' },
      ]);
      expect(h.audits.at(-1)).toMatchObject({ action: 'relay.session.stream.closed' });
      // The id is free again.
      h.send('s2', { op: 'session.stream', streamId: 'st', sessionId: CHAT });
      await h.settle();
      expect(h.streams).toHaveLength(2);
    });

    it('ends one stream from this side with one stream.end carrying the reason', async () => {
      const h = harness();
      h.send('s', { op: 'session.stream', streamId: 'st', sessionId: CHAT });
      await h.settle();
      expect(h.server.endStream('st', { status: 429, code: 'rate_limited', message: 'x' })).toBe(
        true
      );
      await h.settle();
      expect(h.streams[0]!.sink.closed).toBe(true);
      expect(h.frames.filter((f) => f.type === 'stream.end')).toEqual([
        {
          type: 'stream.end',
          streamId: 'st',
          error: { status: 429, code: 'rate_limited', message: 'x' },
        },
      ]);
      expect(h.audits.at(-1)!.summary).not.toBe('Closed a chat on the web');
      expect(h.server.endStream('nope', { status: 429, code: 'rate_limited', message: 'x' })).toBe(
        false
      );
    });

    it('ends with stream.end when the session stream runs out', async () => {
      const h = harness();
      h.send('s', { op: 'session.stream', streamId: 'st', sessionId: CHAT });
      await h.settle();
      h.streams[0]!.done();
      await h.settle();
      expect(h.frames).toEqual([{ type: 'stream.end', streamId: 'st' }]);
    });

    it('tears every stream down when the connection closes, sending nothing', async () => {
      const h = harness();
      h.send('a', { op: 'session.stream', streamId: 'a', sessionId: CHAT });
      h.send('b', { op: 'session.stream', streamId: 'b', sessionId: CHAT });
      await h.settle();
      h.server.closeAll();
      await h.settle();
      expect(h.streams.every((s) => s.sink.closed)).toBe(true);
      expect(h.frames).toEqual([]);
      expect(h.audits.map((a) => a.action)).toContain('relay.connection.closed');
    });

    it('refuses a stream id already open', async () => {
      const h = harness();
      h.send('a', { op: 'session.stream', streamId: 'a', sessionId: CHAT });
      await h.settle();
      h.send('b', { op: 'session.stream', streamId: 'a', sessionId: CHAT });
      // An error for the request, never a stream.end: stream `a` is still live.
      expect(h.frames.at(-1)).toMatchObject({
        type: 'error',
        id: 'b',
        error: { code: 'invalid' },
      });
      expect(h.streams).toHaveLength(1);
    });
  });

  it('audits every op as the owner on the relay surface, naming the chat and never the words', async () => {
    const h = harness();
    h.send('l', { op: 'chats.list', agentId: AGENT_ID });
    h.send('m', { op: 'session.send', sessionId: CHAT, content: 'the secret plan' });
    h.send('i', { op: 'session.interrupt', sessionId: CHAT });
    h.send('q', {
      op: 'interaction.respond',
      sessionId: CHAT,
      answer: { kind: 'answer', toolCallId: 't1', answers: { '0': 'secret answer' } },
    });
    await h.settle();
    expect(h.audits.map((a) => a.action).sort()).toEqual([
      'relay.chats.list',
      'relay.interaction.respond',
      'relay.session.interrupt',
      'relay.session.send',
    ]);
    for (const entry of h.audits) {
      expect(entry.actor).toEqual({ accountId: 'acct-owner', kind: 'person', name: 'Dorian' });
      expect(entry.source?.surface).toBe('relay');
      expect(entry.visibility).toBe('participants');
      expect(entry.participants).toEqual(['acct-owner']);
    }
    expect(h.audits.find((a) => a.action === 'relay.session.send')?.source?.sessionId).toBe(CHAT);
    expect(JSON.stringify(h.audits)).not.toContain('secret');
  });
});
