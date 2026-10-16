/**
 * The freshness window for messages a reconnecting stream missed is derived from how long a
 * reconnect can take (DOR-2976). They were once set apart: a silent drop was noticed after 50
 * seconds while a missed mention woke an agent only under 30, so a mention sent early in the drop
 * stayed unanswered.
 */
import { expect, it } from 'vitest';
import {
  ADDRESS_LOOKUP_TIMEOUT_MS,
  SSE_CONNECT_TIMEOUT_MS,
  SSE_IDLE_TIMEOUT_MS,
} from '../pinned-origin.js';
import { RECONNECT_FRESH_MS, SUBSCRIPTION_RETRY_MS } from '../subscription/reconnect-timing.js';

it('covers the longest a dead link can go unnoticed, the wait to reopen and the slowest answer', () => {
  // Catches the window being set below the worst time to come back, by hand or by raising one of
  // the bounds it is made of.
  const worstReturn =
    SSE_IDLE_TIMEOUT_MS +
    SUBSCRIPTION_RETRY_MS +
    ADDRESS_LOOKUP_TIMEOUT_MS +
    SSE_CONNECT_TIMEOUT_MS;
  expect(RECONNECT_FRESH_MS).toBeGreaterThan(worstReturn);
});

it('stays short enough that a long outage does not wake agents for old mentions', () => {
  // Catches a margin grown until the window means nothing: two minutes at most.
  expect(RECONNECT_FRESH_MS).toBeLessThanOrEqual(2 * 60_000);
});
