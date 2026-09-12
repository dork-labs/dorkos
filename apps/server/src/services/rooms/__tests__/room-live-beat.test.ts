/**
 * One beat for everything live in a room (spec `canvas-agent-seat` §6).
 *
 * Three producers publish on the room's ephemeral lane and each has to restate
 * itself or stop being true: an agent's work claim, a follow claim, and a
 * followed person's position. They used to carry three copies of `10_000` — and
 * the failure mode of two of them drifting apart is invisible, because the
 * symptom is an indicator that simply goes out a third of the time.
 *
 * So the number lives in one place, and this pins every reader of it to that
 * place — including the three a type cannot reach: the server's presence
 * republisher, which keeps its constant module-private; the browser, which
 * cannot import server code; and the browser TEST suite, which depends on
 * neither this package nor the client and so restates the number outright.
 *
 * Seeded defect: changing any one of the four numbers back to a literal reddens
 * exactly the case that names it.
 *
 * @module server/services/rooms/tests/room-live-beat
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOM_LIVE_BEAT_MS, ROOM_LIVE_TTL_MS } from '@dorkos/shared/room-schemas';
import { FOLLOW_CLAIM_TTL_MS, FOLLOW_REFRESH_MS } from '../follow/room-follow-service.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Read one source file of this repo, as text. */
function source(relative: string): string {
  return readFileSync(path.resolve(here, relative), 'utf-8');
}

/**
 * The same file with its comments taken out.
 *
 * Crude on purpose — a `//` inside a string literal would be cut too — and
 * sound for what it is asked: these files hold no URLs, and over-cutting can
 * only make the search below find LESS, which a companion `toContain` case
 * would catch.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('the room’s one ephemeral beat', () => {
  it('is three beats to a lifetime', () => {
    expect(ROOM_LIVE_TTL_MS).toBe(ROOM_LIVE_BEAT_MS * 3);
  });

  it('is what a follow claim is refreshed on, and expires after', () => {
    expect(FOLLOW_REFRESH_MS).toBe(ROOM_LIVE_BEAT_MS);
    expect(FOLLOW_CLAIM_TTL_MS).toBe(ROOM_LIVE_TTL_MS);
  });

  it('is what the presence republisher runs on', () => {
    // Module-private on purpose — nothing outside the dispatcher may set the
    // interval — so the pin is on the assignment rather than on the value.
    // A literal there is exactly the drift this file exists to catch.
    const trigger = source('../room-trigger.ts');
    expect(trigger).toContain('const PRESENCE_REPUBLISH_MS = ROOM_LIVE_BEAT_MS;');
  });

  it('is what the browser refreshes and expires on', () => {
    // The client cannot import this package, so its constants are read as text.
    // The alternative — trusting a comment that says "same as the server" — is
    // what the three copies were.
    const store = source(
      '../../../../../client/src/layers/entities/room/model/live/use-room-follow.ts'
    );
    expect(store).toContain('export const ROOM_FOLLOW_REFRESH_MS = ROOM_LIVE_BEAT_MS;');
    expect(store).toContain('export const ROOM_FOLLOW_TTL_MS = ROOM_LIVE_TTL_MS;');
  });

  it('is what the browser suite waits out, which cannot import it either', () => {
    // `apps/e2e` depends on neither this package nor the client, so its own
    // constant is a restatement — and a restatement outside the pin is the
    // drift this file exists to catch. Read as a number rather than as a
    // string, so changing the shared value reddens here until the spec follows.
    const spec = source('../../../../../e2e/tests/rooms/canvas/room-follow.spec.ts');
    const declared = /const FOLLOW_BEAT_MS = ([\d_]+);/.exec(spec);
    expect(declared, 'room-follow.spec.ts must declare FOLLOW_BEAT_MS').not.toBeNull();
    expect(Number(declared![1]!.replaceAll('_', ''))).toBe(ROOM_LIVE_BEAT_MS);
  });

  it('leaves no bare copy of the number behind, however it is spelled', () => {
    // Comments are stripped first: every one of these files EXPLAINS the beat,
    // and prose naming "10 000" is the point rather than a copy. What is left
    // is code, where any spelling of ten thousand is a second source of truth —
    // `10_000`, `10000`, `10 * 1000`, or one handed straight to a timer.
    const files = [
      '../room-trigger.ts',
      '../follow/room-follow-service.ts',
      '../../../../../client/src/layers/entities/room/model/live/use-room-follow.ts',
      '../../../../../client/src/layers/entities/room/model/live/use-room-follow-claim.ts',
      '../../../../../client/src/layers/entities/room/model/live/use-room-view-publish.ts',
    ];
    const TEN_THOUSAND = /\b10[_\s]?000\b|\b10\s*\*\s*1[_\s]?000\b|\b1[_\s]?000\s*\*\s*10\b/;
    for (const file of files) {
      expect(withoutComments(source(file)), file).not.toMatch(TEN_THOUSAND);
    }
  });
});
