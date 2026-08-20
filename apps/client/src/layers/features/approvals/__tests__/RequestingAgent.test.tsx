// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { hashToHslColor } from '@/layers/shared/lib';
import { RequestingAgent } from '../ui/RequestingAgent';

/** What `backgroundColor` jsdom reports for a disc filled solid with `color`. */
function fill(color: string): string {
  const probe = document.createElement('span');
  probe.style.backgroundColor = color;
  return probe.style.backgroundColor;
}

function avatarIn(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-slot="requesting-agent-avatar"]') as HTMLElement;
}

/** The corner badge, when the disc drew one — see `identity-avatar.test.tsx`'s own helper. */
function badgeOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-slot="requesting-agent-avatar"] > span:nth-of-type(2)');
}

afterEach(cleanup);

describe('RequestingAgent', () => {
  it('names the agent by its last path segment and marks it with that letter', () => {
    const { container } = render(
      <RequestingAgent requestedBy="/Users/dorian/agents/ana" hasAgentPath />
    );

    expect(screen.getByText('ana')).toBeInTheDocument();
    expect(avatarIn(container).textContent).toBe('A');
  });

  it('takes a plain label unchanged', () => {
    const { container } = render(<RequestingAgent requestedBy="Ana" hasAgentPath />);

    expect(screen.getByText('Ana')).toBeInTheDocument();
    expect(avatarIn(container).textContent).toBe('A');
  });

  it('hashes the colour from the whole identity, not from the rendered label', () => {
    // Two agents can share a name; their directories cannot. Hashing the label
    // would give both the same colour in the approvals list.
    const { container } = render(<RequestingAgent requestedBy="/repo/alpha/ana" hasAgentPath />);

    expect(avatarIn(container).style.backgroundColor).toBe(fill(hashToHslColor('/repo/alpha/ana')));
    expect(avatarIn(container).style.backgroundColor).not.toBe(fill(hashToHslColor('ana')));
  });

  it('draws the mark at the size the approvals row is built around', () => {
    const { container } = render(<RequestingAgent requestedBy="/repo/ana" hasAgentPath />);

    expect(avatarIn(container)).toHaveClass('size-[18px]');
  });

  it('draws the square, filled, Bot-badged disc every agent surface draws, once hasAgentPath confirms one', () => {
    // Same convention as everywhere else an agent is drawn (spec
    // `identity-consistency` W1.3): before this, an unresolved requester
    // avatar was indistinguishable from a person's — a round, tinted disc.
    const { container } = render(<RequestingAgent requestedBy="/repo/ana" hasAgentPath />);
    const disc = avatarIn(container);

    // `size="xs"` on the `square` shape steps to `rounded-md` (the base
    // radius) rather than the `sm`/`md`/`lg` compound overrides — see
    // `identity-avatar.tsx`'s own `compoundVariants`.
    expect(disc).toHaveClass('rounded-md');
    expect(disc).not.toHaveClass('rounded-full');
    expect(badgeOf(container)?.querySelector('.lucide-bot')).not.toBeNull();
  });

  it('draws the plain, undeclared circle for a label with no agent path behind it', () => {
    // `requestedBy` is only a display LABEL — the marketplace confirmation
    // flow sets it on approvals that carry no agent path at all
    // (`packages/shared/src/approval-schemas.ts:52-55`). A label alone is not
    // evidence of an agent, so this must NOT draw the square/fill/Bot mark
    // just because a name is present.
    const { container } = render(
      <RequestingAgent requestedBy="Marketplace confirmation" hasAgentPath={false} />
    );
    const disc = avatarIn(container);

    expect(disc).toHaveClass('rounded-full');
    expect(disc).not.toHaveClass('rounded-md');
    expect(badgeOf(container)?.querySelector('.lucide-bot')).toBeFalsy();
  });

  it('is decorative — the name beside it is what gets read out', () => {
    const { container } = render(<RequestingAgent requestedBy="/repo/ana" hasAgentPath />);

    expect(avatarIn(container)).toHaveAttribute('aria-hidden', 'true');
  });

  it('says an unattributed request is unattributed rather than inventing an agent', () => {
    const { container } = render(<RequestingAgent hasAgentPath={false} />);

    expect(screen.getByText(/Requested without an agent identity/i)).toBeInTheDocument();
    expect(avatarIn(container)).toBeNull();
  });
});
