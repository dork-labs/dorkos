// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { hashToHslColor } from '@/layers/shared/lib';
import { RequestingAgent } from '../ui/RequestingAgent';

/** The exact inline tint the shared avatar mixes, normalized through jsdom. */
function tint(color: string): string {
  const probe = document.createElement('span');
  probe.style.backgroundColor = `color-mix(in oklch, ${color} 18%, transparent)`;
  return probe.style.backgroundColor;
}

function avatarIn(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-slot="requesting-agent-avatar"]') as HTMLElement;
}

afterEach(cleanup);

describe('RequestingAgent', () => {
  it('names the agent by its last path segment and marks it with that letter', () => {
    const { container } = render(<RequestingAgent requestedBy="/Users/dorian/agents/ana" />);

    expect(screen.getByText('ana')).toBeInTheDocument();
    expect(avatarIn(container).textContent).toBe('A');
  });

  it('takes a plain label unchanged', () => {
    const { container } = render(<RequestingAgent requestedBy="Ana" />);

    expect(screen.getByText('Ana')).toBeInTheDocument();
    expect(avatarIn(container).textContent).toBe('A');
  });

  it('hashes the colour from the whole identity, not from the rendered label', () => {
    // Two agents can share a name; their directories cannot. Hashing the label
    // would give both the same colour in the approvals list.
    const { container } = render(<RequestingAgent requestedBy="/repo/alpha/ana" />);

    expect(avatarIn(container).style.backgroundColor).toBe(tint(hashToHslColor('/repo/alpha/ana')));
    expect(avatarIn(container).style.backgroundColor).not.toBe(tint(hashToHslColor('ana')));
  });

  it('draws the mark at the size the approvals row is built around', () => {
    const { container } = render(<RequestingAgent requestedBy="/repo/ana" />);

    expect(avatarIn(container)).toHaveClass('size-5');
  });

  it('is decorative — the name beside it is what gets read out', () => {
    const { container } = render(<RequestingAgent requestedBy="/repo/ana" />);

    expect(avatarIn(container)).toHaveAttribute('aria-hidden', 'true');
  });

  it('says an unattributed request is unattributed rather than inventing an agent', () => {
    const { container } = render(<RequestingAgent />);

    expect(screen.getByText(/Requested without an agent identity/i)).toBeInTheDocument();
    expect(avatarIn(container)).toBeNull();
  });
});
