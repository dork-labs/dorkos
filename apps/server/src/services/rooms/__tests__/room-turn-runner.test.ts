/**
 * Original Runner behavior through isolated real Room post/Trigger/constructor turns.
 * Provider output is finite external SDK/TestMode DATA; private requests and native
 * lifetimes are issued only by original constructors and owning HTTP composition.
 * Explicit ordinary predicate, timing and identity algorithms cover schedules that
 * cannot be issued by a native test fixture. Their native pairs have bounded scopes;
 * they do not claim foreign/overlapping private turns or guard-drop mutant proof.
 */
import { describe, expect, vi } from 'vitest';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { warnIfTurnCannotPost } from '../room-turn-runner.js';
import { registerOriginalNativeLaunchCase } from '../repo/__tests__/room-original-native-case.js';
import { registerOriginalNativeDefaultsCase } from '../repo/__tests__/room-original-defaults-case.js';
import { registerOriginalNativeHomeResumeCase } from '../repo/__tests__/room-original-home-resume-case.js';
import { runOriginalReplyIdentityComponent } from '../repo/__tests__/room-original-reply-identity-component.js';
import { runOriginalRoomStopStateComponent } from '../repo/__tests__/room-original-stop-state-component.js';
import { runOriginalReplyWaitClockComponent } from '../repo/__tests__/room-original-reply-wait-clock-component.js';
import { runOriginalLaunchOwnerRollbackComponent } from '../repo/__tests__/room-original-launch-owner-rollback-component.js';

describe('createSessionRoomTurnRunner', () => {
  describe('which runtime takes the turn', () => {
    registerOriginalNativeLaunchCase(
      'runner-bound-codex',
      'keeps a running conversation on the runtime that started it, whatever the manifest now says'
    );

    registerOriginalNativeLaunchCase(
      'runner-first-codex',
      "starts a first turn on the agent's manifest runtime, not on the registry's inference"
    );

    registerOriginalNativeLaunchCase(
      'runner-owner-before-provider',
      'records the session`s runtime before the runtime starts a first turn (DOR-2447)'
    );

    registerOriginalNativeLaunchCase(
      'runner-placeholder-codex',
      'reads an id nothing has bound the same way it reads no id at all'
    );

    registerOriginalNativeLaunchCase(
      'runner-missing-runtime',
      'refuses a turn bound to a runtime this server did not start, by name'
    );

    registerOriginalNativeLaunchCase(
      'runner-no-fallback',
      'never redirects that turn onto a runtime this server does have'
    );

    registerOriginalNativeLaunchCase(
      'runner-bound-halt',
      'aims a halt at the runtime the turn is actually running on'
    );

    registerOriginalNativeLaunchCase(
      'runner-first-captured-halt',
      'keeps a halt on the runtime running a FIRST turn, though the manifest changed under it'
    );

    registerOriginalNativeLaunchCase(
      'runner-remembered-halt',
      "re-aims DOR-1424's remembered stop at the turn's runtime, not the manifest's"
    );

    registerOriginalNativeLaunchCase(
      'runner-released-halt',
      'lets go of the capture when the turn ends, so the next halt asks again'
    );

    registerOriginalNativeLaunchCase(
      'runner-stop-state-pair',
      're-aims a stop that arrived BEFORE the capture at the turn, not at what it reached',
      () => runOriginalRoomStopStateComponent(0)
    );

    registerOriginalNativeLaunchCase(
      'runner-preaccepted-halt',
      'covers the stretch BEFORE the dispatch is accepted, where a claim is already held'
    );

    registerOriginalNativeLaunchCase(
      'runner-canonical-halt',
      'answers a halt that asks with the CANONICAL id the runtime renamed the turn to'
    );

    registerOriginalNativeLaunchCase(
      'runner-stop-state-pair',
      "never lets turn 1's cleanup take away the capture turn 2 has already written",
      () => runOriginalRoomStopStateComponent(1)
    );

    registerOriginalNativeLaunchCase(
      'runner-stop-state-pair',
      're-aims a stop a halt aimed at the CANONICAL id, which is every halt on a late answer',
      () => runOriginalRoomStopStateComponent(2)
    );

    registerOriginalNativeLaunchCase(
      'runner-stop-state-pair',
      'never lets a stop marked on turn 1 be inherited by turn 2 under a shared name',
      () => runOriginalRoomStopStateComponent(3)
    );

    registerOriginalNativeLaunchCase(
      'runner-stop-state-pair',
      'clears a capture left by a turn that threw before its collector existed',
      () => runOriginalRoomStopStateComponent(4)
    );
  });

  describe('the posting posture it asks about, and which path it asks with', () => {
    registerOriginalNativeLaunchCase(
      'runner-posting-home',
      'asks about where the turn RUNS — the agent`s home'
    );

    registerOriginalNativeLaunchCase(
      'runner-false-posting',
      'runs the turn anyway when the session carries no posting tool',
      async () => {
        // Component posture only: this ordinary fake is never registered or
        // used to issue an original Room request or native producer.
        const component = Object.assign(new FakeAgentRuntime(), {
          carriesRoomTools: vi.fn(async () => false),
        });
        const { logger } = await import('../../../lib/logger.js');
        const warning = vi.spyOn(logger, 'warn');
        let failed = false;
        let first: unknown;
        const remember = (cause: unknown) => {
          if (!failed) {
            failed = true;
            first = cause;
          }
        };
        try {
          await warnIfTurnCannotPost({
            runtime: component,
            cwd: '/repo/ana',
            agentPath: '/repo/ana',
            sessionId: 'ordinary-false-posting-component',
          });
          expect(component.carriesRoomTools).toHaveBeenCalledExactlyOnceWith({
            cwd: '/repo/ana',
            agentPath: '/repo/ana',
            sessionId: 'ordinary-false-posting-component',
          });
          expect(warning).toHaveBeenCalledWith(
            '[rooms] this turn has no way to post, so it can only stay silent',
            {
              sessionId: 'ordinary-false-posting-component',
              cwd: '/repo/ana',
              reason: 'the runtime reports that this session does not carry the DorkOS room tools',
            }
          );
        } catch (cause) {
          remember(cause);
        } finally {
          try {
            warning.mockRestore();
          } catch (cause) {
            remember(cause);
          }
        }
        if (failed) throw first;
        // Separate original native provider still must return exact green and
        // undefined unanswered; this does not claim a native false posture.
      }
    );

    registerOriginalNativeLaunchCase(
      'runner-optional-posting',
      'runs the turn for a runtime that does not implement the question',
      async () => {
        // Compatibility component: this supported ordinary fake is never
        // registered as a runtime or used to issue an original Room request.
        const optionalRuntime: AgentRuntime = new FakeAgentRuntime();
        expect(optionalRuntime.carriesRoomTools).toBeUndefined();
        const { logger } = await import('../../../lib/logger.js');
        const warning = vi.spyOn(logger, 'warn');
        let failed = false;
        let first: unknown;
        const remember = (cause: unknown) => {
          if (!failed) {
            failed = true;
            first = cause;
          }
        };
        try {
          await warnIfTurnCannotPost({
            runtime: optionalRuntime,
            cwd: '/repo/ana',
            agentPath: '/repo/ana',
            sessionId: 'ordinary-optional-posting-component',
          });
          expect(warning).not.toHaveBeenCalled();
        } catch (cause) {
          remember(cause);
        } finally {
          try {
            warning.mockRestore();
          } catch (cause) {
            remember(cause);
          }
        }
        if (failed) throw first;
        // The separate owned child keeps the original exact green assertion.
      }
    );
  });

  registerOriginalNativeLaunchCase(
    'runner-home-grants-attachments',
    'hands the runtime its home, exactly its grants, and its copy — and projects files at home'
  );

  registerOriginalNativeLaunchCase(
    'runner-no-files',
    'grants nothing and names no copy for a room without files'
  );

  registerOriginalNativeLaunchCase(
    'runner-bound-launch-context',
    'hands the dispatcher a launch step bound to the session the turn launches on'
  );

  registerOriginalNativeLaunchCase(
    'runner-owner-before-refresh',
    'records the session`s owner before the turn-start refresh runs (DOR-2447)'
  );

  registerOriginalNativeLaunchCase(
    'runner-measured-launch-context',
    'puts the files section the launch step measured into the room context it launches with'
  );

  registerOriginalNativeLaunchCase(
    'runner-accepted-no-files-context',
    'launches with the accepted room context when the launch step has no files to report'
  );

  registerOriginalNativeHomeResumeCase(
    'opencode-copy',
    'starts a fresh session at home, and hands the room the new id'
  );
  registerOriginalNativeHomeResumeCase(
    'opencode-home',
    'carries on an OpenCode session that already stands at home'
  );
  registerOriginalNativeHomeResumeCase(
    'claude-copy',
    'resumes a Claude Code session from the copy at home — it can move'
  );

  registerOriginalNativeLaunchCase(
    'runner-desk-guard',
    'refuses a turn that would stand anywhere but the agent`s home (the desk guard)',
    async () => {
      // Ordinary exported predicate only. Genuine captured placement cannot
      // issue a private Room request with this foreign cwd; no issuer is bypassed.
      const { assertOwnDesk } = await import('../../core/agent-identity/index.js');
      const componentDispatch = vi.fn();
      let refused = false;
      try {
        assertOwnDesk('/repo/ana', '/dork/rooms/r1/worktrees/ana-1a2b3c4d', 'home');
        componentDispatch();
      } catch (cause) {
        expect(cause).toMatchObject({ code: 'DESK_NOT_OWN' });
        refused = true;
      }
      expect(refused).toBe(true);
      expect(componentDispatch).not.toHaveBeenCalled();
      // Separate acquired native turn below proves actual home/provider cwd,
      // rather than claiming a forged foreign private request was admitted.
    }
  );

  registerOriginalNativeLaunchCase(
    'runner-projection-before-provider',
    'has the files on disk BEFORE the turn is triggered'
  );

  registerOriginalNativeLaunchCase(
    'runner-stream-text',
    'returns what the agent said, read off the session stream'
  );

  registerOriginalNativeLaunchCase(
    'runner-paragraphs',
    'keeps two assistant messages apart instead of welding them together'
  );

  registerOriginalNativeLaunchCase(
    'runner-token-counts',
    'does not split one message on the token counts that stream through it'
  );

  registerOriginalNativeLaunchCase(
    'runner-new-then-reused',
    'mints a session on the first answer and reuses the bound one after'
  );

  registerOriginalNativeLaunchCase(
    'runner-canonical-owner',
    'answers on, and records ownership under, the id the runtime assigned'
  );

  registerOriginalNativeLaunchCase(
    'runner-owner-write-failure',
    'still delivers the answer when recording who owns the session fails'
  );

  registerOriginalNativeLaunchCase(
    'runner-foreign-lock',
    'says nothing rather than queueing behind an operator who is mid-turn'
  );

  registerOriginalNativeLaunchCase(
    'runner-busy-disposition',
    'asks to be refused only by a STRANGER, never by its own previous turn'
  );

  registerOriginalNativeLaunchCase(
    'runner-unstarted-cancel-data',
    'stops waiting the moment an accepted trigger is reported as never having run',
    () => runOriginalReplyIdentityComponent('runner-unstarted-cancel-data')
  );

  registerOriginalNativeLaunchCase(
    'runner-started-failed-data',
    'keeps waiting on a turn that DID start and then failed, which has its own reporting',
    () => runOriginalReplyIdentityComponent('runner-started-failed-data')
  );

  registerOriginalNativeLaunchCase(
    'runner-delayed-start-data',
    'reads a turn whose start arrives after the dispatch has already resolved',
    () => runOriginalReplyIdentityComponent('runner-delayed-start-data')
  );

  registerOriginalNativeLaunchCase(
    'runner-failed',
    'reports a turn that ended in an error, rather than an empty answer'
  );

  registerOriginalNativeLaunchCase(
    'runner-quiet',
    'does not mistake a quiet turn for a failed one'
  );

  registerOriginalNativeLaunchCase(
    'runner-late-answer',
    'hands back an answer that outran the wait instead of dropping it',
    runOriginalReplyWaitClockComponent
  );

  registerOriginalNativeLaunchCase(
    'runner-half-answer',
    'never posts the half of an answer it had when the wait ran out'
  );

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
