/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Sparkles } from 'lucide-react';
import '@testing-library/jest-dom/vitest';
import { Badge } from '../badge';

afterEach(cleanup);

describe('Badge', () => {
  // A badge is inline text, and it spent a long time as a `<div>` — which is
  // invalid inside every `<p>` it landed in, and which React renders anyway.
  it('renders a span', () => {
    render(<Badge>New</Badge>);
    expect(screen.getByText('New').tagName).toBe('SPAN');
  });

  // One tint, one radius: no border, no fill per variant.
  it('draws every badge as a full-radius pill on the 7% tint, with no border', () => {
    render(<Badge>Beta</Badge>);
    const badge = screen.getByText('Beta');
    expect(badge).toHaveAttribute('data-slot', 'badge');
    expect(badge).toHaveClass('rounded-full', 'bg-foreground/7', 'tabular-nums');
    expect(badge.className).not.toMatch(/\bborder\b|rounded-md/);
  });

  it('says a neutral fact in the quiet grey', () => {
    render(<Badge>Installed</Badge>);
    const badge = screen.getByText('Installed');
    expect(badge).toHaveAttribute('data-tone', 'neutral');
    expect(badge).toHaveClass('text-muted-foreground');
    expect(badge.querySelector('svg')).toBeNull();
  });

  // Colour on the glyph, never the word: a coloured word fails AA on the tint.
  it.each([
    ['warning', 'text-status-warning-fg', 'lucide-triangle-alert'],
    ['error', 'text-status-error-fg', 'lucide-circle-x'],
    ['success', 'text-status-success-fg', 'lucide-check'],
  ] as const)('a %s badge brings its own glyph in its colour', (tone, color, glyph) => {
    render(<Badge tone={tone}>State</Badge>);
    const badge = screen.getByText('State');
    expect(badge).toHaveClass('text-foreground');
    expect(badge.className).not.toMatch(/text-status-/);
    const icon = badge.querySelector('svg');
    expect(icon).toHaveClass(color, glyph);
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  // Agents send `info` over the gen-ui wire; blue is not a resting state.
  it('draws info as neutral', () => {
    render(<Badge tone="info">Note</Badge>);
    expect(screen.getByText('Note')).toHaveAttribute('data-tone', 'neutral');
  });

  it('takes another glyph, or none', () => {
    render(
      <>
        <Badge tone="success" icon={Sparkles}>
          Swapped
        </Badge>
        <Badge tone="warning" icon={null}>
          Bare
        </Badge>
      </>
    );
    expect(screen.getByText('Swapped').querySelector('svg')).toHaveClass('lucide-sparkles');
    expect(screen.getByText('Bare').querySelector('svg')).toBeNull();
  });

  it('draws the pulsing working dot when live', () => {
    render(<Badge live>3 live</Badge>);
    const badge = screen.getByText('3 live');
    expect(badge).toHaveAttribute('data-live', 'true');
    expect(badge).toHaveClass('text-foreground');
    const dot = badge.querySelector('[data-slot="badge-live-dot"]');
    expect(dot).toHaveClass('bg-status-success', 'motion-safe:animate-pulse');
  });

  // The deprecated props still compile and resolve here until the codemod.
  it('resolves the deprecated variant and shape', () => {
    render(
      <>
        <Badge variant="destructive">Broken</Badge>
        <Badge variant="outline" shape="default">
          Old
        </Badge>
      </>
    );
    expect(screen.getByText('Broken')).toHaveAttribute('data-tone', 'error');
    const old = screen.getByText('Old');
    expect(old).toHaveAttribute('data-tone', 'neutral');
    expect(old).toHaveClass('rounded-full');
  });

  it('lets an explicit tone win over the deprecated variant', () => {
    render(
      <Badge variant="destructive" tone="warning">
        Held
      </Badge>
    );
    expect(screen.getByText('Held')).toHaveAttribute('data-tone', 'warning');
  });

  // A badge that navigates should BE the link, not sit inside one.
  it('becomes the child element with asChild, glyph and all', () => {
    render(
      <Badge asChild tone="warning">
        <a href="/connections">Waiting</a>
      </Badge>
    );
    const link = screen.getByRole('link', { name: 'Waiting' });
    expect(link).toHaveAttribute('data-slot', 'badge');
    expect(link).toHaveClass('bg-foreground/7');
    expect(link.querySelector('svg')).toHaveClass('lucide-triangle-alert');
  });

  it('defaults to the sm size and takes xs at 11px, not the 10px of counts', () => {
    render(
      <>
        <Badge>Default</Badge>
        <Badge size="xs">Tiny</Badge>
      </>
    );
    expect(screen.getByText('Default')).toHaveClass('text-xs');
    const tiny = screen.getByText('Tiny');
    expect(tiny).toHaveClass('text-2xs');
    expect(tiny).not.toHaveClass('text-3xs');
  });
});
