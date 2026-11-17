/**
 * A bridged Telegram or Slack chat hands on outside words unless it is the owner's own linked chat
 * (DOR-4593). With stranger marking on, a bridged turn from anyone but a listed approver in a
 * one-to-one chat is marked, and the chat keeps whether its latest real turn was; a continuation
 * turn never overwrites that. So the owner's hop runs unasked, while a group's, an unlisted
 * sender's, and their continuations still count. With marking off, every bridged chat counts.
 *
 * Read the way a restarted server reads it: from the chat's stored hold, with no turn in memory.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { runtimeRegistry } from '../../runtime-registry.js';
import { chatReadOutsideWords } from '../chat-outside-words.js';
import { noteTurnHold, setContinuationHoldDb } from '../continuation-hold.js';

let origin: string | null;

beforeEach(() => {
  setContinuationHoldDb(createTestDb());
  origin = null;
  vi.spyOn(runtimeRegistry, 'getSessionLaunchOrigin').mockImplementation(() => origin);
});
afterEach(() => {
  setContinuationHoldDb(undefined);
  vi.restoreAllMocks();
});

describe('a bridged chat, with stranger marking on', () => {
  it("the owner's own linked chat hands on clean words", () => {
    origin = 'relay-binding';
    noteTurnHold('owner-dm', false);
    expect(chatReadOutsideWords('owner-dm', undefined, true)).toBe(false);
  });

  it("a stranger's or a group's chat hands on outside words", () => {
    origin = 'relay-binding';
    noteTurnHold('stranger-dm', true);
    expect(chatReadOutsideWords('stranger-dm', undefined, true)).toBe(true);
  });

  it("a stranger's chat still counts after a continuation turn", () => {
    origin = 'relay-binding';
    noteTurnHold('stranger-dm', true);
    // A continuation (an approval's answer delivered, a resume) records nothing, so the last
    // real turn's answer stands.
    expect(chatReadOutsideWords('stranger-dm', undefined, true)).toBe(true);
  });

  it("the owner's chat counts again once a marked turn runs on it", () => {
    origin = 'relay-binding';
    noteTurnHold('shared', false);
    noteTurnHold('shared', true);
    expect(chatReadOutsideWords('shared', undefined, true)).toBe(true);
  });
});

describe('a bridged chat, with stranger marking off', () => {
  it("counts, since nothing tells the owner's chat from a stranger's", () => {
    origin = 'relay-binding';
    noteTurnHold('owner-dm', false);
    expect(chatReadOutsideWords('owner-dm', undefined, false)).toBe(true);
  });
});

describe('the other outside origins', () => {
  it.each(['outside-sender', 'connector-event'])('%s counts whatever the flag says', (o) => {
    origin = o;
    noteTurnHold(`chat-${o}`, false);
    expect(chatReadOutsideWords(`chat-${o}`, undefined, true)).toBe(true);
    expect(chatReadOutsideWords(`chat-${o}`, undefined, false)).toBe(true);
  });

  it("the owner's own chat does not count", () => {
    origin = 'interactive';
    expect(chatReadOutsideWords('mine', undefined, true)).toBe(false);
  });
});
