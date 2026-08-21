/**
 * One row: the face it draws when an agent resolves, the icon it falls back
 * to, and the tone rule that decides between them.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import type { AgentVisualSource } from '@/layers/entities/agent';
import { InboxRow } from '../ui/InboxRow';

/** Build a notification, overriding only what a test cares about. */
function build(overrides: Partial<NotificationDTO> = {}): NotificationDTO {
  return {
    id: '01JZR0000000000000000001',
    kind: 'turn.completed',
    tier: 'notable',
    subject: { type: 'session', id: 'ses-1' },
    sessionId: 'ses-1',
    agentId: 'alpha',
    title: 'alpha finished',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const AGENT: AgentVisualSource = { id: 'alpha', color: '#6366f1', icon: '🐙' };

afterEach(() => {
  cleanup();
});

describe('InboxRow faces', () => {
  it('draws the kind glyph when the caller never resolved an agent', () => {
    render(<InboxRow notification={build()} onOpen={() => {}} />);

    expect(document.querySelector('[data-slot="agent-avatar"]')).not.toBeInTheDocument();
  });

  it('draws the kind glyph when the caller looked and the roster does not know the id', () => {
    render(<InboxRow notification={build()} agent={null} onOpen={() => {}} />);

    expect(document.querySelector('[data-slot="agent-avatar"]')).not.toBeInTheDocument();
  });

  it('draws the agent face when the agent resolved, on a neutral-tone row', () => {
    render(
      <InboxRow
        notification={build({ kind: 'run.completed', tier: 'quiet' })}
        agent={AGENT}
        onOpen={() => {}}
      />
    );

    expect(document.querySelector('[data-slot="agent-avatar"]')).toBeInTheDocument();
  });

  it('still draws a face on a warning-tone row — most ordinary activity IS warning tone', () => {
    // turn.completed defaults to tier: notable, which is the warning tone —
    // this is the common case, not an edge case, and it must not be treated
    // like an error.
    render(
      <InboxRow
        notification={build({ kind: 'turn.completed', tier: 'notable' })}
        agent={AGENT}
        onOpen={() => {}}
      />
    );

    expect(document.querySelector('[data-slot="agent-avatar"]')).toBeInTheDocument();
  });

  it('keeps the coloured kind glyph on an error-tone row even with a resolved agent', () => {
    render(
      <InboxRow
        notification={build({ kind: 'session.error', tier: 'blocking' })}
        agent={AGENT}
        onOpen={() => {}}
      />
    );

    expect(document.querySelector('[data-slot="agent-avatar"]')).not.toBeInTheDocument();
  });

  it('keeps the glyph on a failed run even though the tier alone reads as warning', () => {
    render(
      <InboxRow
        notification={build({ kind: 'run.completed', tier: 'notable' })}
        agent={AGENT}
        onOpen={() => {}}
      />
    );

    expect(document.querySelector('[data-slot="agent-avatar"]')).not.toBeInTheDocument();
  });
});

describe('InboxRow non-interactive rendering', () => {
  it('draws as a button when it can open somewhere', () => {
    render(<InboxRow notification={build()} onOpen={() => {}} />);

    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('draws as plain text with no onOpen — the digest/showcase branch', () => {
    render(<InboxRow notification={build()} />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    const row = document.querySelector('[data-slot="inbox-row"]');
    expect(row).not.toBeNull();
    expect(row?.tagName).toBe('DIV');
  });
});
