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

  it('lets a caller drop the badge without being able to touch the silhouette', () => {
    // The sanctioned opt-out for an agent-only list: keep the square, lose a
    // column of identical glyphs. `shape` stays unreachable either way.
    const { container } = render(<AgentAvatar color="#6366f1" emoji="🔍" badge={null} />);

    expect(avatarOf(container).querySelector('.lucide-bot')).not.toBeInTheDocument();
    expect(avatarOf(container)).toHaveClass('rounded-lg');
  });

  it('never draws a health ring, whatever the mesh thinks', () => {
    // The ring was a second green 2px from the dot, on every list row in the
    // cockpit. Health is a diagnostic, not an identity, and the two surfaces
    // that genuinely need it (the Agent Hub hero, the mesh topology) now say
    // it in their own words.
    const { container } = render(
      // @ts-expect-error — `healthStatus` is no longer part of AgentAvatarProps.
      <AgentAvatar color="#fff" emoji="🤖" healthStatus="inactive" />
    );

    expect(avatarOf(container).className).not.toContain('ring-2');
    expect(avatarOf(container).className).not.toContain('ring-status-warning');
  });

  it('pulses only for an agent a caller says is working right now', () => {
    const { container } = render(<AgentAvatar color="#fff" emoji="🤖" status="working" />);
    const avatar = avatarOf(container);

    expect(avatar.querySelector('.bg-status-success')).toBeInTheDocument();
    expect(avatar.querySelector('.animate-ping')).toBeInTheDocument();
  });

  it('draws nothing at all for an agent that is merely alive', () => {
    // The dot used to light from `healthStatus === 'active'` — the mesh's
    // "seen within the last hour". An hour-old heartbeat drawn as a pulse is a
    // lie about right now, and mesh health no longer reaches this disc at all.
    const { container } = render(
      // @ts-expect-error — `healthStatus` is no longer part of AgentAvatarProps.
      <AgentAvatar color="#fff" emoji="🤖" healthStatus="active" />
    );
    const avatar = avatarOf(container);

    expect(avatar.querySelector('.bg-status-success')).not.toBeInTheDocument();
    expect(avatar.querySelector('.animate-ping')).not.toBeInTheDocument();
    expect(avatar.className).not.toContain('ring-2');
  });

  it('says "needs you" in amber and "error" in red, and neither of them moves', () => {
    // Only working ever animates: motion is what the word "now" is made of, and
    // an amber dot that pulsed would say a blocked turn is still going.
    const { container: amber } = render(<AgentAvatar color="#fff" emoji="🤖" status="needs-you" />);
    expect(avatarOf(amber).querySelector('.bg-status-warning')).toBeInTheDocument();
    expect(avatarOf(amber).querySelector('.animate-ping')).not.toBeInTheDocument();

    const { container: red } = render(<AgentAvatar color="#fff" emoji="🤖" status="error" />);
    expect(avatarOf(red).querySelector('.bg-status-error')).toBeInTheDocument();
    expect(avatarOf(red).querySelector('.animate-ping')).not.toBeInTheDocument();
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

  it('no longer carries mesh health at all', () => {
    // The lockup forwarded `healthStatus` for one reason: the ring the disc
    // drew from it. With the ring gone the prop had nothing left to do, and a
    // pass-through to nowhere is the kind of thing that grows a second meaning.
    const { container } = render(
      // @ts-expect-error — `healthStatus` is no longer part of AgentIdentityProps.
      <AgentIdentity {...baseProps} healthStatus="active" />
    );
    const avatar = container.querySelector('[data-slot="agent-avatar"]')!;

    expect(avatar.className).not.toContain('ring-2');
    expect(avatar.querySelector('.animate-ping')).not.toBeInTheDocument();
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

  // ---------------------------------------------------------------------------
  // The interaction grammar — what this lockup says when you point at it
  // ---------------------------------------------------------------------------

  describe('the identity answers, and it never plays dead', () => {
    it('no longer dims to 80% on hover, the idiom for DISABLED', () => {
      const { container } = render(<AgentIdentity {...baseProps} onClick={vi.fn()} />);

      expect(screen.getByRole('button').className).not.toContain('opacity-80');
      expect(container.querySelector('[data-slot="agent-avatar"]')!.className).not.toContain(
        'opacity-80'
      );
    });

    it('gives a keyboard the ring a mouse never needed and never had', () => {
      // This branch shipped with no focus response of any kind: a keyboard user
      // could tab onto the control and see nothing at all.
      render(<AgentIdentity {...baseProps} onClick={vi.fn()} />);

      expect(screen.getByRole('button').className).toContain('focus-ring');
    });

    it('rings the disc in the agent’s own colour, on hover and on focus alike', () => {
      const { container } = render(<AgentIdentity {...baseProps} onClick={vi.fn()} />);
      const avatar = container.querySelector('[data-slot="agent-avatar"]')!;

      // A NAMED group on the control is what carries both states to the disc.
      expect(screen.getByRole('button').className.split(' ')).toContain('group/identity');
      expect(avatar.className).toContain('group-hover/identity:ring-2');
      expect(avatar.className).toContain('group-focus-visible/identity:ring-2');
      expect(avatar.className).toContain('var(--identity-color)');
    });

    it('never uses the BARE group, which an unrelated ancestor can fire', () => {
      // Tailwind compiles `group-hover:` to `:where(.group):hover &` — ANY
      // `.group` ancestor, not the nearest. The sidebar wraps its rows in an
      // unnamed `.group` spanning most of the pane, so the bare form left every
      // sidebar face permanently ringed: a hover state that was never not on.
      // Browser-caught; jsdom renders no ancestors and cannot see it.
      const { container } = render(
        <AgentIdentity {...baseProps} onAvatarClick={vi.fn()} avatarLabel="Open profile" />
      );
      const face = container.querySelector('[data-slot="agent-identity-face"]')!;
      const avatar = container.querySelector('[data-slot="agent-avatar"]')!;

      expect(face.className.split(' ')).not.toContain('group');
      expect(avatar.className).not.toMatch(/(^|\s)group-hover:/);
      expect(avatar.className).not.toMatch(/(^|\s)group-focus-visible:/);
    });

    it('always rings the disc when the lockup is a control — nothing competes for it now', () => {
      // The disc used to spend its 2px ring on mesh health, so a pressable
      // lockup carrying health took no identity ring and fell back to a neutral
      // row hover instead. The health ring is gone, so the identity's own
      // colour is the only answer there is, and it is never stood down.
      const { container } = render(<AgentIdentity {...baseProps} onClick={vi.fn()} />);

      expect(screen.getByRole('button').className).not.toContain('hover:bg-accent');
      expect(container.querySelector('[data-slot="agent-avatar"]')!.className).toContain(
        'group-hover/identity:ring-2'
      );
    });

    it('leaves an inert lockup with no states to promise', () => {
      const { container } = render(<AgentIdentity {...baseProps} />);
      const avatar = container.querySelector('[data-slot="agent-avatar"]')!;

      expect(avatar.className).not.toContain('group-hover/identity:ring-2');
      expect(container.querySelector('[data-slot="agent-identity"]')!.className).not.toContain(
        'cursor-pointer'
      );
    });

    it('gives the face-alone control a mark-sized press and its own ring', () => {
      const { container } = render(
        <AgentIdentity {...baseProps} onAvatarClick={vi.fn()} avatarLabel="Open Scout’s profile" />
      );
      const face = container.querySelector('[data-slot="agent-identity-face"]')!;

      expect(face.className).not.toContain('opacity-80');
      // 0.94, not 0.98: one press number cannot fit a 300px card and a 24px disc.
      expect(face.className).toContain('active:scale-[0.94]');
      expect(container.querySelector('[data-slot="agent-avatar"]')!.className).toContain(
        'group-hover/identity:ring-2'
      );
    });
  });
});
