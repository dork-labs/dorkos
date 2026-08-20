import { describe, it, expect } from 'vitest';
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';
import type { PendingInteractionDTO } from '@dorkos/shared/schemas';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import {
  askCopy,
  askDeepLink,
  earnsNativeBanner,
  notificationDeepLink,
  replyEligibility,
  sessionLabelFor,
} from '../copy';

function approvalInteraction(
  overrides: Partial<Extract<PendingInteractionDTO, { type: 'approval' }>> = {}
): PendingInteractionDTO {
  return {
    type: 'approval',
    id: 'tool-1',
    startedAt: 0,
    remainingMs: 60_000,
    toolName: 'Bash',
    input: 'rm -rf /',
    hasSuggestions: false,
    ...overrides,
  };
}

function questionInteraction(
  questions: Extract<PendingInteractionDTO, { type: 'question' }>['questions']
): PendingInteractionDTO {
  return {
    type: 'question',
    id: 'question-1',
    startedAt: 0,
    remainingMs: 60_000,
    questions,
  };
}

function ask(
  interaction: PendingInteractionDTO,
  overrides: Partial<InteractionPendingEvent> = {}
): InteractionPendingEvent {
  return {
    sessionId: 'session-1',
    cwd: '/Users/dork/projects/dorkos',
    interaction,
    ...overrides,
  };
}

describe('sessionLabelFor', () => {
  it('is the basename of the working directory', () => {
    expect(sessionLabelFor('/Users/dork/projects/dorkos')).toBe('dorkos');
  });

  it('falls back to "A session" with no cwd', () => {
    expect(sessionLabelFor(undefined)).toBe('A session');
  });

  it('falls back to "A session" for a root path with no basename', () => {
    expect(sessionLabelFor('/')).toBe('A session');
  });
});

describe('askCopy', () => {
  it('titles an approval with the session label, and bodies it with the tool action', () => {
    const copy = askCopy(ask(approvalInteraction({ displayName: 'Delete a directory' })));
    expect(copy.title).toBe('dorkos is waiting on your answer');
    expect(copy.body).toBe('Delete a directory');
  });

  it('never leaks the raw tool input into the body', () => {
    const copy = askCopy(ask(approvalInteraction({ displayName: undefined, title: undefined })));
    expect(copy.body).not.toContain('rm -rf');
    expect(copy.body).toBe('Wants to run Bash');
  });

  it('bodies a single-question ask with the question text', () => {
    const copy = askCopy(
      ask(
        questionInteraction([
          {
            header: 'Color',
            question: 'What color should the button be?',
            options: [],
            multiSelect: false,
          },
        ])
      )
    );
    expect(copy.body).toBe('What color should the button be?');
  });

  it('bodies a multi-question ask with a count, not the individual questions', () => {
    const copy = askCopy(
      ask(
        questionInteraction([
          { header: 'Color', question: 'What color?', options: [], multiSelect: false },
          { header: 'Size', question: 'What size?', options: [], multiSelect: false },
        ])
      )
    );
    expect(copy.body).toBe('Asked you 2 questions');
  });
});

describe('replyEligibility', () => {
  it('offers a reply for a single-question ask, with the question as placeholder', () => {
    const eligible = replyEligibility(
      questionInteraction([
        {
          header: 'Color',
          question: 'What color should the button be?',
          options: [],
          multiSelect: false,
        },
      ])
    );
    expect(eligible).toEqual({ placeholder: 'What color should the button be?' });
  });

  it('refuses a reply for a multi-question ask — one text field cannot answer two questions', () => {
    const eligible = replyEligibility(
      questionInteraction([
        { header: 'Color', question: 'What color?', options: [], multiSelect: false },
        { header: 'Size', question: 'What size?', options: [], multiSelect: false },
      ])
    );
    expect(eligible).toBeNull();
  });

  it('refuses a reply for an approval', () => {
    expect(replyEligibility(approvalInteraction())).toBeNull();
  });

  it('refuses a reply for a multi-select question — the answer is a set, not a string', () => {
    const eligible = replyEligibility(
      questionInteraction([
        {
          header: 'Toppings',
          question: 'Which toppings?',
          options: [{ label: 'Cheese' }, { label: 'Olives' }],
          multiSelect: true,
        },
      ])
    );
    expect(eligible).toBeNull();
  });

  it('refuses a reply for a single-select question with fixed options — typed text could match none of them', () => {
    const eligible = replyEligibility(
      questionInteraction([
        {
          header: 'Environment',
          question: 'Which environment?',
          options: [{ label: 'Staging' }, { label: 'Production' }],
          multiSelect: false,
        },
      ])
    );
    expect(eligible).toBeNull();
  });

  it('truncates a long question for the placeholder', () => {
    const longQuestion = 'W'.repeat(200);
    const eligible = replyEligibility(
      questionInteraction([
        { header: 'H', question: longQuestion, options: [], multiSelect: false },
      ])
    );
    expect(eligible?.placeholder.length).toBe(120);
    expect(eligible?.placeholder.endsWith('…')).toBe(true);
  });
});

describe('askDeepLink', () => {
  it('addresses the session the ask is parked on', () => {
    expect(askDeepLink(ask(approvalInteraction(), { sessionId: 'abc-123' }))).toBe(
      '/session?session=abc-123'
    );
  });
});

describe('earnsNativeBanner', () => {
  it('blocking always earns one, focused or not', () => {
    expect(earnsNativeBanner('blocking', false)).toBe(true);
    expect(earnsNativeBanner('blocking', true)).toBe(true);
  });

  it('notable only earns one while no window is focused', () => {
    expect(earnsNativeBanner('notable', true)).toBe(true);
    expect(earnsNativeBanner('notable', false)).toBe(false);
  });

  it('quiet never earns one', () => {
    expect(earnsNativeBanner('quiet', true)).toBe(false);
    expect(earnsNativeBanner('quiet', false)).toBe(false);
  });
});

function notificationDto(overrides: Partial<NotificationDTO> = {}): NotificationDTO {
  return {
    id: 'notif-1',
    kind: 'turn.completed',
    tier: 'notable',
    subject: { type: 'session', id: 'session-1' },
    title: 'my-session finished a turn',
    createdAt: '2026-08-19T00:00:00.000Z',
    ...overrides,
  };
}

describe('notificationDeepLink', () => {
  it('addresses a session subject via the sessionId lens', () => {
    const dto = notificationDto({
      sessionId: 'session-42',
      subject: { type: 'session', id: 'session-42' },
    });
    expect(notificationDeepLink(dto)).toBe('/session?session=session-42');
  });

  it('addresses a room subject via the roomId lens', () => {
    const dto = notificationDto({
      kind: 'dm.received',
      tier: 'notable',
      subject: { type: 'room', id: 'room-1' },
      roomId: 'room-1',
    });
    expect(notificationDeepLink(dto)).toBe('/channels?id=room-1');
  });

  it('opens an agent profile from the home route', () => {
    const dto = notificationDto({
      subject: { type: 'agent', id: 'agent-1' },
      agentId: 'agent-1',
    });
    expect(notificationDeepLink(dto)).toBe('/?profile=agent-1');
  });

  it('lands a task subject on the Tasks page', () => {
    const dto = notificationDto({
      kind: 'run.completed',
      subject: { type: 'task', id: 'task-1' },
    });
    expect(notificationDeepLink(dto)).toBe('/tasks');
  });

  it('lands a run subject on the Tasks page', () => {
    const dto = notificationDto({
      kind: 'run.completed',
      subject: { type: 'run', id: 'run-1' },
    });
    expect(notificationDeepLink(dto)).toBe('/tasks');
  });

  it('brings the app forward for a system subject', () => {
    const dto = notificationDto({
      kind: 'update.installed',
      tier: 'quiet',
      subject: { type: 'system', id: 'system' },
    });
    expect(notificationDeepLink(dto)).toBe('/');
  });
});
