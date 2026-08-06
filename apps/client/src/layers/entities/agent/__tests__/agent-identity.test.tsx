// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import { AgentAvatar } from '../ui/AgentAvatar';
import { AgentIdentity } from '../ui/AgentIdentity';

beforeEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// AgentAvatar
// ---------------------------------------------------------------------------

describe('AgentAvatar', () => {
  /** The disc this wrapper drew. */
  const avatarOf = (container: HTMLElement) =>
    container.querySelector('[data-slot="agent-avatar"]') as HTMLElement;

  it('renders emoji inside a filled square wearing the Bot mark', () => {
    // Square, filled and badged is what an agent looks like, and this wrapper
    // is the path 12 surfaces reach it through — none of them says so itself.
    // The default size is `sm`, whose square radius is `rounded-lg`.
    const { container } = render(<AgentAvatar color="#6366f1" emoji="🔍" />);
    const avatar = avatarOf(container);

    expect(avatar).toBeInTheDocument();
    expect(avatar).toHaveTextContent('🔍');
    expect(avatar).toHaveClass('rounded-lg');
    expect(avatar).not.toHaveClass('rounded-full');
    expect(avatar.querySelector('.lucide-bot')).toBeInTheDocument();
  });

  it('fills with the agent colour outright rather than tinting the surface behind it', () => {
    const { container } = render(<AgentAvatar color="#6366f1" emoji="🔍" />);
    const probe = document.createElement('span');
    probe.style.backgroundColor = '#6366f1';

    expect(avatarOf(container).style.backgroundColor).toBe(probe.style.backgroundColor);
  });

  it('takes no shape or variant — the convention is unskippable through this path', () => {
    // A caller that could pass `shape="circle"` is exactly how an agent got
    // drawn as a person in 18 of the 20 places that draw one. The compile-time
    // half of this assertion is the `@ts-expect-error`: it fails the build if
    // the prop ever becomes assignable again. The runtime half proves the
    // narrowing is not cosmetic — the ignored prop changes nothing.
    const { container } = render(
      <AgentAvatar
        color="#6366f1"
        emoji="🔍"
        // @ts-expect-error — `shape` is not part of AgentAvatarProps.
        shape="circle"
      />
    );

    expect(avatarOf(container)).toHaveClass('rounded-lg');
    expect(avatarOf(container)).not.toHaveClass('rounded-full');
  });

  it('renders different sizes via size prop', () => {
    const { container, rerender } = render(<AgentAvatar color="#fff" emoji="🤖" size="xs" />);

    const xsClasses = avatarOf(container).className;
    rerender(<AgentAvatar color="#fff" emoji="🤖" size="lg" />);
    const lgClasses = avatarOf(container).className;

    // Different sizes produce different class lists
    expect(xsClasses).not.toEqual(lgClasses);
  });

  it('shows active health tasks indicator', () => {
    // The dot is the shared `working` slot now, in the theme's own green —
    // `bg-emerald-500` was a hardcoded colour this component had no business
    // owning, and the room roster drew the same fact a different way.
    const { container } = render(<AgentAvatar color="#fff" emoji="🤖" healthStatus="active" />);
    const avatar = avatarOf(container);

    expect(avatar.className).toContain('ring-2');
    expect(avatar.querySelector('.animate-ping')).toBeInTheDocument();
    expect(avatar.querySelector('.bg-status-success')).toBeInTheDocument();
    expect(avatar.querySelector('.bg-emerald-500')).not.toBeInTheDocument();
  });

  it('shows health ring without tasks for non-active statuses', () => {
    const { container } = render(<AgentAvatar color="#fff" emoji="🤖" healthStatus="inactive" />);
    const avatar = avatarOf(container);
    expect(avatar.className).toContain('ring-2');
    expect(avatar.querySelector('.animate-ping')).not.toBeInTheDocument();
  });

  it('has no health ring when healthStatus is omitted', () => {
    const { container } = render(<AgentAvatar color="#fff" emoji="🤖" />);
    expect(avatarOf(container).className).not.toContain('ring-2');
  });

  it('pulses for an agent that is working, whatever the mesh thinks of its health', () => {
    // Health is "can I reach it"; working is "is it doing something". A caller
    // that knows the second can say so without inventing a health status.
    const { container } = render(<AgentAvatar color="#fff" emoji="🤖" working />);
    const avatar = avatarOf(container);

    expect(avatar.querySelector('.bg-status-success')).toBeInTheDocument();
    expect(avatar.className).not.toContain('ring-2');
  });

  it('lets an explicit working={false} silence the dot a live health status implies', () => {
    const { container } = render(
      <AgentAvatar color="#fff" emoji="🤖" healthStatus="active" working={false} />
    );

    expect(avatarOf(container).querySelector('.bg-status-success')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// AgentIdentity
// ---------------------------------------------------------------------------

describe('AgentIdentity', () => {
  const baseProps = { color: '#6366f1', emoji: '🔍', name: 'code-reviewer' };

  it('renders avatar + name', () => {
    const { container } = render(<AgentIdentity {...baseProps} />);
    expect(container.querySelector('[data-slot="agent-avatar"]')).toBeInTheDocument();
    expect(screen.getByText('code-reviewer')).toBeInTheDocument();
  });

  it('renders detail when provided', () => {
    render(<AgentIdentity {...baseProps} detail="claude-code" />);
    expect(screen.getByText('claude-code')).toBeInTheDocument();
  });

  it('omits detail element when not provided', () => {
    const { container } = render(<AgentIdentity {...baseProps} />);
    // Scoped to the label beside the avatar: the disc has muted-foreground of
    // its own on the Bot badge's plate, which is not a detail line.
    const label = container.querySelector(
      '[data-slot="agent-identity"] [data-slot="agent-avatar"] ~ span'
    )!;
    expect(label.querySelectorAll('[class*="muted-foreground"]')).toHaveLength(0);
  });

  it('uses inline layout for xs/sm sizes', () => {
    const { container } = render(<AgentIdentity {...baseProps} size="xs" detail="runtime" />);
    const identity = container.querySelector('[data-slot="agent-identity"]')!;
    expect(identity.querySelector('.items-center')).toBeInTheDocument();
    expect(identity.querySelector('.flex-col')).not.toBeInTheDocument();
  });

  it('uses stacked layout for md/lg sizes', () => {
    const { container } = render(<AgentIdentity {...baseProps} size="md" detail="runtime" />);
    const identity = container.querySelector('[data-slot="agent-identity"]')!;
    expect(identity.querySelector('.flex-col')).toBeInTheDocument();
  });

  it('keeps the name in the accessibility tree when it is hidden', () => {
    // The narrowest tier of the status line's width budget shows the avatar alone.
    // The name stays announced — and keeps naming the button — rather than vanishing.
    const { container } = render(<AgentIdentity {...baseProps} nameHidden onClick={vi.fn()} />);
    expect(container.querySelector('[data-slot="agent-avatar"]')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'code-reviewer' })).toBeInTheDocument();
    expect(screen.getByText('code-reviewer').className).toContain('sr-only');
  });

  it('forwards healthStatus to AgentAvatar', () => {
    const { container } = render(<AgentIdentity {...baseProps} healthStatus="active" />);
    const avatar = container.querySelector('[data-slot="agent-avatar"]')!;
    expect(avatar.className).toContain('ring-2');
    expect(avatar.querySelector('.animate-ping')).toBeInTheDocument();
  });

  it('applies custom className to root', () => {
    const { container } = render(<AgentIdentity {...baseProps} className="my-custom-class" />);
    const identity = container.querySelector('[data-slot="agent-identity"]')!;
    expect(identity.className).toContain('my-custom-class');
  });

  // ---------------------------------------------------------------------------
  // Interactivity — onClick makes the component a button
  // ---------------------------------------------------------------------------

  it('renders as a button when onClick is provided', () => {
    render(<AgentIdentity {...baseProps} onClick={vi.fn()} />);
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('renders as a span (no button role) when onClick is not provided', () => {
    render(<AgentIdentity {...baseProps} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    // The root element should still be present as a span
    const { container } = render(<AgentIdentity {...baseProps} />);
    const identity = container.querySelector('[data-slot="agent-identity"]')!;
    expect(identity.tagName).toBe('SPAN');
  });

  it('fires onClick when the button is clicked', () => {
    const handleClick = vi.fn();
    render(<AgentIdentity {...baseProps} onClick={handleClick} />);
    fireEvent.click(screen.getByRole('button'));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('applies interactive styling when onClick is provided', () => {
    render(<AgentIdentity {...baseProps} onClick={vi.fn()} />);
    const button = screen.getByRole('button');
    expect(button.className).toContain('cursor-pointer');
  });
});
