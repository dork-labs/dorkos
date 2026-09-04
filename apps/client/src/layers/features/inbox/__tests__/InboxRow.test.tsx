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
import { InboxRow, INBOX_STAGGER_LIMIT, staggerItem, staggerVariantsFor } from '../ui/InboxRow';

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

describe('InboxRow glyph slot', () => {
  it('wraps both the icon and the face in a fixed-width slot, so the title column does not jitter', () => {
    const { rerender } = render(<InboxRow notification={build()} onOpen={() => {}} />);
    const iconSlot = document.querySelector('[data-slot="inbox-row-glyph"]');
    expect(iconSlot).toHaveClass('size-[18px]');

    rerender(
      <InboxRow
        notification={build({ kind: 'run.completed', tier: 'quiet' })}
        agent={AGENT}
        onOpen={() => {}}
      />
    );
    const faceSlot = document.querySelector('[data-slot="inbox-row-glyph"]');
    expect(faceSlot).toHaveClass('size-[18px]');
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

describe('staggerVariantsFor', () => {
  it('gives the entrance to the first eight rows', () => {
    expect(staggerVariantsFor(0)).toBe(staggerItem);
    expect(staggerVariantsFor(INBOX_STAGGER_LIMIT - 1)).toBe(staggerItem);
  });

  it('drops the entrance past the cap, so a long Inbox does not read as latency', () => {
    expect(staggerVariantsFor(INBOX_STAGGER_LIMIT)).toBeUndefined();
    expect(staggerVariantsFor(59)).toBeUndefined();
  });

  it('keeps the entrance where there is no list position — a group member, a showcase', () => {
    expect(staggerVariantsFor(undefined)).toBe(staggerItem);
  });
});
