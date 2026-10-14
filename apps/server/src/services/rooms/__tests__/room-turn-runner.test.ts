/**
 * Original Runner behavior through isolated real Room post/Trigger/constructor turns.
 * Provider output is finite external SDK/TestMode DATA; private requests and native
 * lifetimes are issued only by original constructors and owning HTTP composition.
 * Explicit ordinary predicate, timing and identity algorithms cover schedules that
 * cannot be issued by a native test fixture. Their native pairs have bounded scopes;
 * they do not claim foreign/overlapping private turns or guard-drop mutant proof.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSessionRoomTurnRunner } from '../room-turn-runner.js';
import type { RoomTurnRequest } from '../room-trigger.js';
import { registerOriginalNativeLaunchCase } from '../repo/__tests__/room-original-native-case.js';
import { registerOriginalNativeDefaultsCase } from '../repo/__tests__/room-original-defaults-case.js';
import { runOriginalReplyIdentityComponent } from '../repo/__tests__/room-original-reply-identity-component.js';
import { runOriginalRoomStopStateComponent } from '../repo/__tests__/room-original-stop-state-component.js';
import { runOriginalLaunchOwnerRollbackComponent } from '../repo/__tests__/room-original-launch-owner-rollback-component.js';

describe('createSessionRoomTurnRunner', () => {
  describe('which runtime takes the turn', () => {
    it('starts no turn for a paused agent, and writes nothing (spec audit-trail PR5)', async () => {
      const { initAgentPause, resetAgentPause } = await import('../../mesh/pause/agent-pause.js');
      const { refusePausedRoomTurn } = await import('../turn-guards/paused-turn.js');
      const recordHeld = vi.fn();
      const pausedAgentOfTurn = vi.fn((opts: { forAgent?: string }) =>
        opts.forAgent === '/repo/ana' ? { id: 'agent-ana', name: 'Ana' } : undefined
      );
      const waitMs = vi.fn(() => 500);
      const runner = createSessionRoomTurnRunner({ waitMs });
      // Only these DATA fields may be read before the pause refuses the turn.
      // The genuine factory owns the private key; no request grants launch authority.
      const pausedRequest = {
        cwd: '/repo/ana',
        agentPath: '/repo/ana',
        sessionId: null,
      } as RoomTurnRequest;
      initAgentPause({ pausedAgentOfTurn, recordHeld } as never);
      try {
        for (const foreignKey of [{}, runner, new Proxy({}, {})]) {
          expect(() => refusePausedRoomTurn(foreignKey, pausedRequest)).toThrow();
        }
        expect(pausedAgentOfTurn).not.toHaveBeenCalled();
        expect(recordHeld).not.toHaveBeenCalled();
        await expect(runner.run(pausedRequest)).rejects.toMatchObject({ code: 'AGENT_PAUSED' });
        // The refusal precedes the first original wait/runtime/placement work.
        expect(waitMs).not.toHaveBeenCalled();
        expect(recordHeld).toHaveBeenCalledWith(
          { id: 'agent-ana', name: 'Ana' },
          expect.objectContaining({ via: 'room' })
        );
      } finally {
        resetAgentPause();
      }
    });
  });

  registerOriginalNativeLaunchCase(
    'runner-own-tail-data',
    'reads its own turn, never the tail of the one already running',
    () => runOriginalReplyIdentityComponent('runner-own-tail-data')
  );

  registerOriginalNativeLaunchCase(
    'runner-foreign-words-data',
    'ignores a turn it did not start, even one carrying the same words',
    () => runOriginalReplyIdentityComponent('runner-foreign-words-data')
  );

  describe('the grace before it says so', () => {
    registerOriginalNativeLaunchCase(
      'runner-approval-quick',
      'says nothing at all about an approval somebody answers straight away'
    );

    registerOriginalNativeLaunchCase(
      'runner-approval-standing',
      'says so once when the prompt is still standing a minute later'
    );

    registerOriginalNativeLaunchCase(
      'runner-approval-failed',
      'reports the wait first and the failure after, when a stall kills the turn'
    );

    registerOriginalNativeLaunchCase(
      'runner-approval-ended',
      'forgets a standing prompt when the turn ends without resolving it'
    );
  });

  registerOriginalNativeLaunchCase(
    'runner-own-activity-data',
    'reports what its OWN turn is doing, and nothing another turn does',
    () => runOriginalReplyIdentityComponent('runner-own-activity-data')
  );

  registerOriginalNativeLaunchCase(
    'runner-foreign-approval-data',
    'says nothing about a prompt raised inside somebody else s turn',
    () => runOriginalReplyIdentityComponent('runner-foreign-approval-data')
  );

  registerOriginalNativeLaunchCase(
    'runner-clamped-ceiling',
    'keeps listening for at least as long as it waits, whatever the pair says'
  );

  registerOriginalNativeLaunchCase(
    'runner-unclosed-ceiling',
    'gives up on a turn that never closes, and says the turn failed'
  );

  registerOriginalNativeLaunchCase(
    'runner-no-binding',
    'writes no runtime binding for a turn that never started',
    runOriginalLaunchOwnerRollbackComponent
  );

  describe('a stop pressed while the turn is still starting', () => {
    registerOriginalNativeLaunchCase(
      'runner-boot-stop',
      'stops the turn the moment it exists, instead of letting it run'
    );

    registerOriginalNativeLaunchCase(
      'runner-confirmed-stop',
      'leaves a turn that stops promptly alone, because it was already stopped'
    );

    registerOriginalNativeLaunchCase(
      'runner-unconfirmed-stop',
      'does NOT latch an `unconfirmed` stop — that turn is running, not booting'
    );

    registerOriginalNativeLaunchCase(
      'runner-missing-halt',
      'reports a stop it could not even find a runtime for'
    );

    registerOriginalNativeLaunchCase(
      'runner-stop-state-pair',
      'never aims it at the NEXT turn, which is the room asking again',
      () => runOriginalRoomStopStateComponent(5)
    );
  });

  registerOriginalNativeLaunchCase('runner-empty-text', 'treats an empty turn as nothing to post');

  registerOriginalNativeLaunchCase(
    'runner-turn-boundary',
    'stops at the turn boundary rather than swallowing the next turn'
  );
});

describe('what a room turn actually sends (ADR-0273)', () => {
  registerOriginalNativeLaunchCase(
    'runner-content',
    'sends the message byte for byte, with nothing wrapped around it'
  );

  registerOriginalNativeLaunchCase(
    'runner-framing',
    'puts the room framing in the context bag instead'
  );
});

describe('what a room turn runs with (execution defaults)', () => {
  registerOriginalNativeDefaultsCase(
    'defaults-server',
    "starts a room agent's first turn on the server's default model and effort"
  );
  registerOriginalNativeDefaultsCase(
    'defaults-existing',
    'leaves a room session that already has settings alone'
  );
  registerOriginalNativeDefaultsCase(
    'defaults-empty',
    'sends no model at all when nothing is configured'
  );
  registerOriginalNativeDefaultsCase(
    'defaults-agent',
    "runs the turn on the addressed agent's own model and effort"
  );
  registerOriginalNativeDefaultsCase(
    'defaults-missing-runtime',
    'never seeds a Codex model onto the claude-code session a missing runtime falls back to'
  );
  registerOriginalNativeDefaultsCase(
    'defaults-registered-codex',
    'still seeds that model once the runtime it was written for is registered'
  );
  registerOriginalNativeDefaultsCase(
    'defaults-kept-effort',
    "keeps the server's effort for an agent that only names a model"
  );
  registerOriginalNativeDefaultsCase(
    'defaults-relay-equality',
    'answers the same for a relay-triggered turn as for a room turn'
  );
});

/**
 * A room agent runs at the power level the operator chose (DOR-1917).
 *
 * The reported break, in the operator's own words: "I've set my power setting to
 * Full autonomy. I expect all new sessions to start with Full autonomy, but
 * that's not happening." Create a room, add an agent, @-mention it — and the
 * session that starts stopped to ask, in the one place nobody is there to
 * answer.
 *
 * Two wires carried the setting before this, and rooms were on neither: the
 * `interactive: true` flag (the chat send path) and `resolveUnattendedDefaultStop`
 * asked for by name (scheduled runs). The `full-power-defaults` programme
 * promised "unattended surfaces at the operator's power level" and ADR
 * 260822-235802 wired tasks and bindings; a room has no per-surface permission
 * control of its own, so the grant had nowhere to land at all.
 *
 * **Half of it moved in DOR-2105.** The ROW's power is no longer resolved here
 * at all: `persistSessionRuntime` takes a required turn origin, and the one
 * mapping in `services/session/origin/turn-origin.ts` reads the operator's stop off
 * `{ kind: 'room' }` — so what these cases pin about the row is the
 * DECLARATION, and that the fact deciding it (`externalAuthor`) travels with
 * it. What the row is then born with is pinned where it is decided
 * (`core/__tests__/runtime-registry.test.ts`) and end to end over a real
 * config and a real registry (`routes/__tests__/default-trust-stop.integration.test.ts`).
 * The per-TURN mode below is still this file's, because the row is written
 * after the turn starts and cannot seed the turn that matters.
 *
 * These controls observe copied computed defaults immediately before the
 * original dispatch and inspect the actual persisted session rows. Provider
 * behavior comes from finite external SDK DATA under the real constructor.
 */
describe('what power a room turn runs at (DOR-1917)', () => {
  registerOriginalNativeDefaultsCase(
    'power-first',
    'runs a new room session at the operator’s Full autonomy, on the FIRST turn'
  );
  registerOriginalNativeDefaultsCase(
    'power-origin',
    'records that level on the row, so every turn after it inherits the ordinary way'
  );
  registerOriginalNativeDefaultsCase(
    'power-vocabulary',
    'resolves the stop through the runtime’s own vocabulary, not a mode id'
  );
  registerOriginalNativeDefaultsCase(
    'power-gate-clamps',
    "starts at the agent's own stop only as the permission gate reads it"
  );
  registerOriginalNativeDefaultsCase(
    'power-gate-keeps',
    "uses the agent's own stop when the gate reader keeps it"
  );
  registerOriginalNativeDefaultsCase(
    'power-runtime-beats-global',
    'lets the per-runtime setting beat the global one'
  );
  registerOriginalNativeDefaultsCase(
    'power-omitted',
    'sends no permission mode at all when no stop is configured'
  );
  registerOriginalNativeDefaultsCase(
    'power-existing',
    'leaves a room conversation that already has settings alone'
  );
  registerOriginalNativeDefaultsCase(
    'power-external-clamp',
    'never lets a stranger on a bridged chat start a session at that level'
  );
  registerOriginalNativeDefaultsCase(
    'power-external-model',
    'still carries the model and effort for that stranger’s turn'
  );
  registerOriginalNativeDefaultsCase(
    'power-model-and-mode',
    'carries the model and the power level together on one first turn'
  );
});

/**
 * A room turn leaves a durable record, whatever runtime it ran on (DOR-784).
 *
 * Rooms are the one surface with nobody watching. Everywhere else a person is
 * holding `GET /api/sessions/:id/events` while the turn runs, so a failure is on
 * their screen; a room triggers a turn into the dark. On 2026-07-31 an agent
 * went quiet in a room for forty-one minutes and `session_events` held zero rows
 * about it — there was no way to tell whether the turn had run, failed, or never
 * started.
 *
 * The rows are a RECORD, never a history: claude-code's history is SDK JSONL and
 * stays there (ADR 260710-024641, as retired in part by 260731-211050). So the
 * second test here is as load-bearing as the
 * first — persisting the whole stream is the thing that ADR ruled out, and a
 * change that "fixed" the first test by turning on full persistence would put
 * every `text_delta` of every room turn in the database.
 */
describe('a room turn is recorded durably', () => {
  registerOriginalNativeDefaultsCase(
    'durable-claude-boundaries',
    'writes rows for a claude-code turn, which used to write none'
  );

  registerOriginalNativeDefaultsCase(
    'durable-claude-no-text',
    'keeps only the boundaries, so the transcript is not double-stored'
  );

  registerOriginalNativeLaunchCase(
    'runner-durable-error',
    'records the failure of a turn that ended in an error'
  );

  registerOriginalNativeLaunchCase(
    'runner-durable-log',
    'still stores a log-backed runtime in full, because there the rows ARE the history'
  );
});

// Upstream power-flow subjects run through the same real isolated native construction.
describe('upstream Room turn permission bounds with original ownership', () => {
  registerOriginalNativeLaunchCase(
    'runner-canonical-level',
    'carries the turn’s recorded level to the id the runtime renamed it to'
  );
  registerOriginalNativeDefaultsCase(
    'power-stranger-existing',
    'holds a stranger’s turn in an existing Full autonomy conversation to its bound'
  );
  registerOriginalNativeDefaultsCase(
    'power-agent-bound',
    'holds a turn another agent’s post started to that agent’s level'
  );
  registerOriginalNativeDefaultsCase(
    'power-human-unbounded',
    'sends no bound for a person’s own message'
  );
});
