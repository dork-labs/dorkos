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
import { registerOriginalNativeHomeResumeCase } from '../repo/__tests__/room-original-home-resume-case.js';
import { runOriginalReplyIdentityComponent } from '../repo/__tests__/room-original-reply-identity-component.js';
import { runOriginalRoomStopStateComponent } from '../repo/__tests__/room-original-stop-state-component.js';
import { runOriginalReplyWaitClockComponent } from '../repo/__tests__/room-original-reply-wait-clock-component.js';

// Both cases use an independently owned native fixture. The outsider post is
// visible context, never a synthetic turn request or an answered sender.
registerOriginalNativeLaunchCase(
  'runner-outsider-context',
  "marks a native turn shown a stranger's line it does not answer without bounding its power"
);

registerOriginalNativeLaunchCase(
  'runner-local-context',
  'leaves a fresh native local-only turn without an outsider marker'
);

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
});
