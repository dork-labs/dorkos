import { describe, it, expect } from 'vitest';
import type { ErrorCategory } from '@dorkos/shared/types';
import type { ChatMessage } from '@/layers/shared/model';
import { resolveSigninResumeText, type SigninResumeState } from '../resolve-signin-resume';

function userMsg(content: string, id = 'u1'): ChatMessage {
  return { id, role: 'user', content, parts: [{ type: 'text', text: content }], timestamp: '' };
}

function assistantMsg(parts: ChatMessage['parts'], id = 'a1'): ChatMessage {
  return { id, role: 'assistant', content: '', parts, timestamp: '' };
}

function errorPart(category?: ErrorCategory) {
  return { type: 'error' as const, message: 'it broke', ...(category ? { category } : {}) };
}

/** The state right after an auth failure: one turn, one inline auth_error part. */
function authFailedState(overrides: Partial<SigninResumeState> = {}): SigninResumeState {
  return {
    messages: [userMsg('fix the build'), assistantMsg([errorPart('auth_error')])],
    status: 'error',
    lastErrorCategory: 'auth_error',
    queuedCount: 0,
    draft: '',
    ...overrides,
  };
}

describe('resolveSigninResumeText', () => {
  it('resends the failed prompt when the auth failure is still the last thing that happened', () => {
    expect(resolveSigninResumeText(authFailedState())).toBe('fix the build');
  });

  it('resends on the notice path, where the failure left no inline error part', () => {
    // TurnFailedNotice's own render condition: status `error`, nothing inline.
    // The card is on screen there too, so its sign-in must resume too.
    expect(
      resolveSigninResumeText(
        authFailedState({ messages: [userMsg('fix the build')], status: 'error' })
      )
    ).toBe('fix the build');
  });

  describe('declines when the person moved on', () => {
    it('when a newer turn already succeeded', () => {
      // They sent something else while the sign-in ran, and it worked. The
      // failed turn is history now; re-sending it would be a message nobody
      // asked for, in the middle of a conversation that recovered without us.
      expect(
        resolveSigninResumeText(
          authFailedState({
            messages: [
              userMsg('fix the build'),
              assistantMsg([errorPart('auth_error')]),
              userMsg('never mind, list the files', 'u2'),
              assistantMsg([{ type: 'text', text: 'here they are' }], 'a2'),
            ],
            status: 'idle',
            lastErrorCategory: undefined,
          })
        )
      ).toBeNull();
    });

    it('when a turn is already running', () => {
      expect(resolveSigninResumeText(authFailedState({ status: 'streaming' }))).toBeNull();
    });

    it('when messages are already waiting on the queue', () => {
      expect(resolveSigninResumeText(authFailedState({ queuedCount: 1 }))).toBeNull();
    });

    it('when the newest failure is not the one signing in fixed', () => {
      // A turn that died of something else since. Signing in did not fix THAT,
      // so presenting the resume as a fix for it would be a lie.
      expect(
        resolveSigninResumeText(
          authFailedState({
            messages: [userMsg('fix the build'), assistantMsg([errorPart('execution_error')])],
            lastErrorCategory: 'execution_error',
          })
        )
      ).toBeNull();
    });

    it('when the turn ended on a failure nothing could classify', () => {
      // An UNCATEGORISED error part is by definition one nothing could name —
      // the CLI's own limit and connection notices arrive that way (DOR-1649).
      // The transcript already withholds Retry from those for the same reason;
      // sending automatically would be a stronger claim than Retry makes.
      expect(
        resolveSigninResumeText(
          authFailedState({
            messages: [userMsg('fix the build'), assistantMsg([errorPart()])],
          })
        )
      ).toBeNull();
    });

    it('when the last error part of the failed turn is not an auth error', () => {
      // One turn can fold in more than one error part. The LAST one is what the
      // turn ended on, so it decides — an auth error earlier in the same turn
      // does not license a resume.
      expect(
        resolveSigninResumeText(
          authFailedState({
            messages: [
              userMsg('fix the build'),
              assistantMsg([errorPart('auth_error'), errorPart('execution_error')]),
            ],
          })
        )
      ).toBeNull();
    });
  });

  describe('the draft rule', () => {
    it('declines when the composer holds newer intent', () => {
      expect(resolveSigninResumeText(authFailedState({ draft: 'actually, do this instead' }))).toBe(
        null
      );
    });

    it('resumes when the composer holds only whitespace', () => {
      // A stray space is not a sentence, and treating it as one would silently
      // withhold the resume for a box that looks empty.
      expect(resolveSigninResumeText(authFailedState({ draft: '   \n ' }))).toBe('fix the build');
    });
  });

  describe('when there is nothing to resend', () => {
    it('declines on an empty transcript', () => {
      expect(
        resolveSigninResumeText(authFailedState({ messages: [], lastErrorCategory: 'auth_error' }))
      ).toBeNull();
    });

    it('declines when the last user message is blank', () => {
      expect(
        resolveSigninResumeText(
          authFailedState({
            messages: [userMsg('   '), assistantMsg([errorPart('auth_error')])],
          })
        )
      ).toBeNull();
    });

    it('declines when the transcript ends cleanly with no failure at all', () => {
      expect(
        resolveSigninResumeText(
          authFailedState({
            messages: [userMsg('fix the build'), assistantMsg([{ type: 'text', text: 'done' }])],
            status: 'idle',
            lastErrorCategory: undefined,
          })
        )
      ).toBeNull();
    });
  });

  it('resends the NEWEST failed prompt when a second turn auth-failed too', () => {
    // The sign-in was still running when they tried again and hit the same
    // wall. The message they want sent is the one they just typed, which is
    // also what Retry would send — the two never disagree.
    expect(
      resolveSigninResumeText(
        authFailedState({
          messages: [
            userMsg('fix the build'),
            assistantMsg([errorPart('auth_error')]),
            userMsg('fix the build please', 'u2'),
            assistantMsg([errorPart('auth_error')], 'a2'),
          ],
        })
      )
    ).toBe('fix the build please');
  });
});
