import { describe, expect, it } from 'vitest';
import type { ConnectorUsageItem } from '@dorkos/shared/connector-schemas';
import {
  actionName,
  eventNoticeLabel,
  retryLine,
  tryItPrompts,
  usageLine,
} from '../lib/app-panel-copy';
import { disconnectImpactLine } from '../ui/panel/AccountPanelMore';

function usage(over: Partial<ConnectorUsageItem> = {}): ConnectorUsageItem {
  return {
    logicalOperationId: 'op-1',
    attemptIndex: 1,
    surface: 'mcp',
    actorKind: 'agent',
    agentId: 'dorkbot',
    connectionId: 'c-1' as never,
    toolkit: 'gmail',
    operationRevisionId: 'send-v1',
    operationSlug: 'GMAIL_SEND_EMAIL',
    payer: 'dorkos_managed',
    outcome: 'success',
    startedAt: '2026-09-26T10:00:00.000Z',
    completedAt: '2026-09-26T10:00:02.000Z',
    ...over,
  };
}

describe('actionName', () => {
  it('turns an action id into plain words, dropping the app’s own prefix', () => {
    expect(actionName('GMAIL_SEND_EMAIL', 'gmail')).toBe('Send email');
    expect(actionName('gmail.messages.list', 'gmail')).toBe('List');
    expect(actionName('LINEAR_CREATE_ISSUE', 'linear')).toBe('Create issue');
  });
});

describe('usageLine', () => {
  const names = { dorkbot: 'DorkBot' };

  it('names the agent and what it did', () => {
    expect(usageLine(usage(), 'gmail', names)).toBe('DorkBot · Send email');
  });

  it('says so when an action did not finish, or its result is unknown', () => {
    expect(usageLine(usage({ outcome: 'error' }), 'gmail', names)).toBe(
      'DorkBot · Send email (didn’t finish)'
    );
    expect(usageLine(usage({ outcome: 'outcome_unknown' }), 'gmail', names)).toBe(
      'DorkBot · Send email (result unknown)'
    );
    expect(usageLine(usage({ outcome: undefined, completedAt: undefined }), 'gmail', names)).toBe(
      'DorkBot · Send email (in progress)'
    );
  });

  it('names the person, a program, or an unknown agent plainly', () => {
    expect(usageLine(usage({ actorKind: 'operator', agentId: undefined }), 'gmail', {})).toMatch(
      /^You · /
    );
    expect(usageLine(usage({ actorKind: 'program', agentId: undefined }), 'gmail', {})).toMatch(
      /^A program · /
    );
    expect(usageLine(usage({ agentId: 'gone' }), 'gmail', {})).toMatch(/^An agent · /);
  });
});

describe('tryItPrompts and eventNoticeLabel', () => {
  it('offers hand-picked prompts for popular apps and none for the rest', () => {
    expect(tryItPrompts('gmail')).toContain('Summarise today’s Gmail inbox');
    expect(tryItPrompts('some-unknown-app')).toEqual([]);
  });

  it('names new-event notifications per app, with a plain fallback', () => {
    expect(eventNoticeLabel('gmail', 'Gmail')).toBe('When a new email arrives…');
    expect(eventNoticeLabel('zoho', 'Zoho')).toBe('When something new happens in Zoho…');
  });
});

describe('disconnectImpactLine', () => {
  const zero = {
    affectedAgentCount: 0,
    affectedSessionCount: 0,
    affectedSubscriptionCount: 0,
    pendingDeliveryCount: 0,
  };

  it('names who loses access and never reads out a zero', () => {
    expect(disconnectImpactLine(['DorkBot', 'mailroom'], { ...zero, affectedAgentCount: 2 })).toBe(
      'DorkBot and mailroom will lose access.'
    );
  });

  it('adds only the counts that are true', () => {
    expect(
      disconnectImpactLine(['DorkBot'], {
        ...zero,
        affectedAgentCount: 1,
        affectedSessionCount: 3,
        pendingDeliveryCount: 1,
      })
    ).toBe(
      'DorkBot will lose access. 3 open chats will stop using it. 1 waiting delivery won’t be sent.'
    );
  });

  it('says plainly when no agent uses it', () => {
    expect(disconnectImpactLine([], zero)).toBe('No agent uses it right now.');
  });
});

describe('retryLine', () => {
  const now = new Date(2026, 8, 27, 12, 30);
  const time = (at: Date) => at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  it('names the clock time for a retry later today', () => {
    const at = new Date(2026, 8, 27, 12, 48);
    expect(retryLine(at.toISOString(), now)).toBe(`Trying again at ${time(at)}.`);
  });

  it('names the day for a retry that falls on another day', () => {
    const at = new Date(2026, 8, 28, 0, 30);
    expect(retryLine(at.toISOString(), now)).toBe(
      `Trying again ${at.toLocaleDateString([], { weekday: 'long' })} at ${time(at)}.`
    );
  });

  it('says now once the retry time has passed', () => {
    expect(retryLine(new Date(2026, 8, 27, 12, 29).toISOString(), now)).toBe('Trying again now.');
  });
});
