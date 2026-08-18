/**
 * The one sentence an Ask leads with, and the rule that it never invents.
 *
 * Seeded defect, run and red: drop the last rung (`needs your OK to run
 * {tool}`) and a prompt that named neither an action nor a path renders
 * "wants to undefined".
 */
import { describe, it, expect } from 'vitest';
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';
import type { PendingInteractionDTO } from '@dorkos/shared/types';
import { askHeadline } from '../lib/ask-headline';

const NOW = Date.parse('2026-08-18T10:00:00.000Z');

/** One prompt from a session in `/projects/meeting-notes`. */
function ask(interaction: PendingInteractionDTO): InteractionPendingEvent {
  return { sessionId: 'session-1', cwd: '/projects/meeting-notes', interaction };
}

/** A permission prompt, with only the fields a case cares about set. */
function approval(
  overrides: Partial<Extract<PendingInteractionDTO, { type: 'approval' }>> = {}
): PendingInteractionDTO {
  return {
    type: 'approval',
    id: 'tc-1',
    startedAt: NOW,
    remainingMs: 600_000,
    toolName: 'Edit',
    input: JSON.stringify({ file_path: '/projects/meeting-notes/standup.md' }),
    hasSuggestions: false,
    ...overrides,
  };
}

describe('askHeadline', () => {
  it('says what the agent wants to do, in the prompt’s own words', () => {
    expect(askHeadline(ask(approval({ displayName: 'Edit standup.md' })), 'Meeting Notes')).toBe(
      'Meeting Notes wants to edit standup.md'
    );
  });

  it('names the file when the SDK’s display name is just the tool’s own name', () => {
    // The real shape a `Write` arrives in: `displayName: "Write"`, which says
    // nothing the tool name did not. Taking it at face value produced
    // "wants to write" with no file in it on every fleet-wide card.
    const realWrite = approval({
      toolName: 'Write',
      displayName: 'Write',
      description: '/projects/meeting-notes/standup.md',
      input: JSON.stringify({ file_path: '/projects/meeting-notes/standup.md' }),
    });
    expect(askHeadline(ask(realWrite), 'Meeting Notes')).toBe(
      'Meeting Notes wants to write standup.md'
    );
  });

  it('falls back to the tool’s own label when the prompt named no action', () => {
    // `getToolLabel` is the transcript's phrasing for the same call, so the
    // card and the transcript say the same thing about the same tool.
    expect(askHeadline(ask(approval()), 'Meeting Notes')).toBe(
      'Meeting Notes wants to edit standup.md'
    );
  });

  it('names the path when that is all the prompt gave', () => {
    // A tool whose input the label reader cannot parse: it echoes the tool
    // name back, which is the "the prompt gave nothing" signal.
    const noLabel = approval({
      toolName: 'Bash',
      input: 'not json at all',
      blockedPath: '/projects/meeting-notes/notes/standup.md',
    });
    expect(askHeadline(ask(noLabel), 'Meeting Notes')).toBe(
      'Meeting Notes needs your OK for standup.md'
    );
  });

  it('names only the tool when the prompt gave neither an action nor a path', () => {
    // The rung that stops the card inventing a verb. The SDK prompt carries a
    // title, a display name, a description and a blocked path; when it carries
    // none of them, the tool is the only true thing left to say.
    const bare = approval({ toolName: 'Bash', input: 'not json at all' });
    expect(askHeadline(ask(bare), 'Meeting Notes')).toBe('Meeting Notes needs your OK to run Bash');
  });

  it('has one line for a question and one for an elicitation', () => {
    expect(
      askHeadline(
        ask({ type: 'question', id: 'q-1', startedAt: NOW, remainingMs: 600_000, questions: [] }),
        'Meeting Notes'
      )
    ).toBe('Meeting Notes has a question');

    expect(
      askHeadline(
        ask({
          type: 'elicitation',
          id: 'e-1',
          startedAt: NOW,
          remainingMs: 600_000,
          serverName: 'linear',
          message: 'Pick a team',
        }),
        'Meeting Notes'
      )
    ).toBe('Meeting Notes needs something from linear');
  });

  it('names the agent by its directory when nothing has resolved a name', () => {
    // The wire carries no name on purpose, so this is the floor every surface
    // falls back to rather than drawing a blank.
    expect(askHeadline(ask(approval({ displayName: 'Edit standup.md' })))).toBe(
      'meeting-notes wants to edit standup.md'
    );
  });
});
