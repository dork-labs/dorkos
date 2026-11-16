/**
 * "Kept" asks the person it was promised to (DOR-3034): one ask per keep, Yes confirms, Not yet
 * reopens it and wakes its agent even past the date, and every way out of kept ends the ask and
 * what was delivered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { AuditLog } from '../../audit/audit-log.js';
import { AccountIds } from '../../audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../audit/audit-trail.js';
import { TodoPromiseService, type TodoPromiseDueEvent } from '../todo-promise-service.js';
import { TodoPromiseStore } from '../todo-promise-store.js';
import { TodoService } from '../todo-service.js';
import { TodoStore } from '../todo-store.js';
import { TodoConfirm } from '../notice/todo-confirm.js';
import { createTodosGatherer } from '../../heartbeats/gatherers/todo-promises.js';
import { standingKey, triageByRules } from '../../heartbeats/triage-rules.js';

const START = new Date('2026-11-15T09:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const AGENT = { kind: 'agent', agentId: 'agent-a' } as const;
const PERSON = { kind: 'person' } as const;

describe('TodoConfirm', () => {
  let db: Db;
  let service: TodoPromiseService;
  let confirm: TodoConfirm;
  let clearNotice: ReturnType<typeof vi.fn<(id: string) => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    db = createTestDb();
    initAuditTrail({
      log: new AuditLog(db),
      accounts: new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => null }),
    });
    service = new TodoPromiseService({ store: new TodoPromiseStore(db) });
    clearNotice = vi.fn<(id: string) => void>();
    confirm = new TodoConfirm({
      store: new TodoPromiseStore(db),
      reopen: (actor, id, note) => service.update(actor, id, { state: 'open', note, from: 'kept' }),
      wakeNow: (id) => service.wakeNow(id),
      clearNotice,
    });
  });

  afterEach(() => {
    service.stop();
    resetAuditTrail();
    vi.useRealTimers();
  });

  /** A promise to the person, kept by its agent with a link, and asked about. */
  function keptAndAsked(dueAt = new Date(START.getTime() + 5 * HOUR).toISOString()) {
    const made = service.create('agent-a', { what: 'Ship the fix', to: 'owner', dueAt });
    service.update(AGENT, made.id, { state: 'kept', delivered: 'https://github.com/a/b/pull/1' });
    expect(confirm.ask(made.id)).toBe(true);
    return made.id;
  }

  it('confirms on Yes, clears the Inbox ask, and asks only once per keep', () => {
    const id = keptAndAsked();
    expect(confirm.ask(id)).toBe(false);
    expect(confirm.answer(PERSON, id, 'yes')).toMatchObject({ confirmState: 'confirmed' });
    expect(clearNotice).toHaveBeenCalledWith(id);
    expect(() => confirm.answer(PERSON, id, 'yes')).toThrow(
      expect.objectContaining({ code: 'NOTHING_TO_CHANGE' })
    );
  });

  it('on Not yet past the date, reopens it and wakes the agent now, with a fresh grace', () => {
    const wakes: TodoPromiseDueEvent[] = [];
    service.observe((event) => wakes.push(event));
    const id = keptAndAsked(new Date(START.getTime() + 2 * HOUR).toISOString());
    vi.advanceTimersByTime(3 * HOUR);
    const reopened = confirm.answer(PERSON, id, 'not-yet');
    expect(reopened).toMatchObject({ state: 'open', confirmState: 'not-yet', delivered: null });
    expect(wakes.map((event) => event.phase)).toEqual(['start']);
    expect(service.lastWakeOf(id)).toMatchObject({ phase: 'start', notYet: true });
    vi.advanceTimersByTime(10 * 60_000);
    expect(service.get(id)!.state).toBe('open');
  });

  it('gives a Not yet its own beat key, even past the date', async () => {
    const id = keptAndAsked(new Date(START.getTime() + HOUR).toISOString());
    vi.advanceTimersByTime(2 * HOUR);
    confirm.answer(PERSON, id, 'not-yet');
    const changes = await createTodosGatherer(service)({
      agent: { id: 'agent-a' },
      now: new Date(),
    } as never);
    const wake = service.lastWakeOf(id)!;
    expect(changes.map((c) => [c.key, c.signal])).toContainEqual([
      `commitment:${id}:start:${wake.at}`,
      'commitment-start',
    ]);
  });

  it('after a Not yet and a moved date, the new start, check-in and overdue each reach the agent', async () => {
    const wakes: TodoPromiseDueEvent[] = [];
    service.observe((event) => wakes.push(event));
    const made = service.create('agent-a', {
      what: 'Ship the fix',
      to: 'owner',
      dueAt: new Date(START.getTime() + 5 * HOUR).toISOString(),
      estimate: 'hour',
    });
    service.update(AGENT, made.id, { state: 'kept' });
    confirm.ask(made.id);
    confirm.answer(PERSON, made.id, 'not-yet');
    const gather = async () =>
      createTodosGatherer(service)({ agent: { id: 'agent-a' }, now: new Date() } as never);
    const seen = new Set<string>();
    const isWork = async () => {
      const changes = await gather();
      const verdict = triageByRules(changes, { failureStorm: false, seenStanding: seen }).verdict;
      changes.forEach((c) => seen.add(standingKey(c)));
      return verdict;
    };
    expect(await isWork()).toBe('work');
    // A new date ten hours out: an hour of work starts 75 minutes before, checks in halfway.
    service.update(AGENT, made.id, {
      state: 'open',
      dueAt: new Date(Date.now() + 10 * HOUR).toISOString(),
    });
    expect(service.get(made.id)!.confirmState).toBeNull();
    vi.advanceTimersByTime(10 * HOUR - 75 * 60_000);
    expect(wakes.map((e) => e.phase)).toEqual(['start', 'start']);
    expect(await isWork()).toBe('work');
    vi.advanceTimersByTime(37.5 * 60_000);
    expect(wakes.map((e) => e.phase)).toEqual(['start', 'start', 'checkin']);
    expect(await isWork()).toBe('work');
    vi.advanceTimersByTime(38 * 60_000);
    expect(await isWork()).toBe('work');
  });

  it('wakes the agent at once on a Not yet before the start window, and on an undated promise', () => {
    const wakes: TodoPromiseDueEvent[] = [];
    service.observe((event) => wakes.push(event));
    const early = keptAndAsked(new Date(START.getTime() + 3 * 24 * HOUR).toISOString());
    confirm.answer(PERSON, early, 'not-yet');
    expect(wakes.map((e) => e.todoPromise.id)).toEqual([early]);
    const undated = service.create('agent-a', { what: 'Tidy up', to: 'owner' });
    service.update(AGENT, undated.id, { state: 'kept' });
    confirm.ask(undated.id);
    confirm.answer(PERSON, undated.id, 'not-yet');
    expect(wakes.map((e) => e.todoPromise.id)).toEqual([early, undated.id]);
    expect(service.lastWakeOf(undated.id)).toMatchObject({ notYet: true });
  });

  it('takes no answer after the day it waits, and marks the ask read only once answered', () => {
    const id = keptAndAsked();
    vi.advanceTimersByTime(25 * HOUR);
    expect(() => confirm.answer(PERSON, id, 'yes')).toThrow(
      expect.objectContaining({ code: 'NOTHING_TO_CHANGE' })
    );
    expect(clearNotice).not.toHaveBeenCalled();
  });

  it('asks again after a Not yet is kept again', () => {
    const id = keptAndAsked();
    confirm.answer(PERSON, id, 'not-yet');
    service.update(AGENT, id, { state: 'kept' });
    expect(confirm.ask(id)).toBe(true);
  });

  it('ends the ask and what was delivered on a drop, and on a reopen through the to-dos service', () => {
    const dropped = keptAndAsked();
    service.update(PERSON, dropped, { state: 'dropped' });
    expect(service.get(dropped)).toMatchObject({ confirmState: null, delivered: null });

    const todos = new TodoService({
      store: new TodoStore(db),
      agentExists: () => true,
      mayAssign: () => true,
      rearm: (id) => service.track(id),
    });
    // A to-do the person gave the agent, to themselves: the to-dos service may reopen it.
    const given = service.create(
      'agent-a',
      { what: 'Send the deck', to: 'owner' },
      { kind: 'person', proven: true }
    );
    service.update(AGENT, given.id, { state: 'kept', delivered: 'https://example.com/d' });
    expect(confirm.ask(given.id)).toBe(true);
    const id = given.id;
    todos.update({ kind: 'person', proven: true } as never, id, { state: 'open' });
    expect(service.get(id)).toMatchObject({ state: 'open', confirmState: null, delivered: null });
    // Kept again: a fresh ask.
    service.update(AGENT, id, { state: 'kept' });
    expect(confirm.ask(id)).toBe(true);
  });

  it('saves a link on a promise already kept, and refuses one with any other state', () => {
    const made = service.create('agent-a', { what: 'Ship it', to: 'owner' });
    expect(() => service.update(AGENT, made.id, { state: 'dropped', delivered: 'x' })).toThrow(
      expect.objectContaining({ code: 'NOTHING_TO_CHANGE' })
    );
    service.update(AGENT, made.id, { state: 'kept' });
    expect(
      service.update(AGENT, made.id, { state: 'kept', delivered: 'https://example.com/f' })
    ).toMatchObject({ delivered: 'https://example.com/f' });
    // And a reopen forgets it.
    expect(service.update(PERSON, made.id, { state: 'open' })).toMatchObject({ delivered: null });
  });
});
