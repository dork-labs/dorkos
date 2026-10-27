/**
 * One row: the face it draws when an agent resolves, the icon it falls back
 * to, and the tone rule that decides between them.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import type { AgentVisualSource } from '@/layers/entities/agent';
const navigate = vi.hoisted(() => vi.fn());

vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useSafeNavigate: () => navigate,
}));

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

    expect(document.querySelector('[data-slot="identity-avatar"]')).not.toBeInTheDocument();
  });

  it('draws the kind glyph when the caller looked and the roster does not know the id', () => {
    render(<InboxRow notification={build()} agent={null} onOpen={() => {}} />);

    expect(document.querySelector('[data-slot="identity-avatar"]')).not.toBeInTheDocument();
  });

  it('draws the agent face when the agent resolved, on a neutral-tone row', () => {
    render(
      <InboxRow
        notification={build({ kind: 'run.completed', tier: 'quiet' })}
        agent={AGENT}
        onOpen={() => {}}
      />
    );

    expect(document.querySelector('[data-slot="identity-avatar"]')).toBeInTheDocument();
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

    expect(document.querySelector('[data-slot="identity-avatar"]')).toBeInTheDocument();
  });

  it('keeps the coloured kind glyph on an error-tone row even with a resolved agent', () => {
    render(
      <InboxRow
        notification={build({ kind: 'session.error', tier: 'blocking' })}
        agent={AGENT}
        onOpen={() => {}}
      />
    );

    expect(document.querySelector('[data-slot="identity-avatar"]')).not.toBeInTheDocument();
  });

  it('keeps the glyph on a failed run even though the tier alone reads as warning', () => {
    render(
      <InboxRow
        notification={build({ kind: 'run.completed', tier: 'notable' })}
        agent={AGENT}
        onOpen={() => {}}
      />
    );

    expect(document.querySelector('[data-slot="identity-avatar"]')).not.toBeInTheDocument();
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

describe('InboxRow: a failing schedule’s Open schedule (DOR-3123)', () => {
  const failing = build({
    kind: 'run.completed',
    tier: 'notable',
    subject: { type: 'run', id: 'run-1' },
    title: 'Nightly backup needs attention',
    actions: [{ id: 'open-schedule', label: 'Open schedule', style: 'primary' }],
  });

  it('draws Open schedule beside a row that offers it, and never a raise', () => {
    render(<InboxRow notification={failing} onOpen={() => {}} />);

    expect(screen.getByRole('button', { name: 'Open schedule' })).toBeInTheDocument();
    expect(screen.queryByText(/Full autonomy|Allow|Raise/)).toBeNull();
  });

  it('opens the Schedules page filtered to the failing ones', () => {
    navigate.mockClear();
    render(<InboxRow notification={failing} onOpen={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open schedule' }));
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: { health: 'failing' } })
    );
  });

  it('gives the reason two lines and the action its own full-width line on a phone', () => {
    render(<InboxRow notification={{ ...failing, body: 'Bash was refused.' }} onOpen={() => {}} />);

    expect(screen.getByText('Bash was refused.')).toHaveClass('line-clamp-2', 'sm:truncate');
    expect(screen.getByRole('button', { name: 'Open schedule' })).toHaveClass(
      'h-11',
      'w-full',
      'sm:w-auto'
    );
  });

  it('draws the Schedules row’s marks, never a red tick', () => {
    const { container } = render(
      <InboxRow notification={{ ...failing, mark: 'refused' }} onOpen={() => {}} />
    );
    expect(container.querySelector('[data-slot="inbox-row-glyph"] .lucide-lock')).not.toBeNull();
    expect(
      container.querySelector('[data-slot="inbox-row-glyph"] .lucide-circle-check')
    ).toBeNull();
    cleanup();

    const crossed = render(
      <InboxRow notification={{ ...failing, mark: 'failed' }} onOpen={() => {}} />
    );
    expect(
      crossed.container.querySelector(
        '[data-slot="inbox-row-glyph"] [class*="lucide-circle-x"], [data-slot="inbox-row-glyph"] .lucide-x-circle'
      )
    ).not.toBeNull();
  });

  it('leaves every other row on one line', () => {
    render(<InboxRow notification={build({ body: 'alpha said hi' })} onOpen={() => {}} />);

    expect(screen.getByText('alpha said hi')).toHaveClass('truncate');
    expect(screen.getByText('alpha said hi')).not.toHaveClass('line-clamp-2');
  });

  it('draws nothing extra on a row that only pictures the notice, or offers no action', () => {
    render(<InboxRow notification={failing} />);
    expect(screen.queryByRole('button', { name: 'Open schedule' })).toBeNull();
    cleanup();

    render(<InboxRow notification={build({ kind: 'run.completed' })} onOpen={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Open schedule' })).toBeNull();
  });
});
