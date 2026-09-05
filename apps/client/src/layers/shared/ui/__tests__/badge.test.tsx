/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { STATUS_TONE_TEXT } from '../status-dot';
import { Badge } from '../badge';

afterEach(cleanup);

describe('Badge', () => {
  // A badge is inline text, and it spent a long time as a `<div>` — which is
  // invalid inside every `<p>` it landed in, and which React renders anyway.
  it('renders a span', () => {
    render(<Badge>New</Badge>);
    expect(screen.getByText('New').tagName).toBe('SPAN');
  });

  it('names itself with data-slot and data-variant', () => {
    render(<Badge variant="outline">Beta</Badge>);
    const badge = screen.getByText('Beta');
    expect(badge).toHaveAttribute('data-slot', 'badge');
    expect(badge).toHaveAttribute('data-variant', 'outline');
  });

  // A badge that navigates should BE the link, not sit inside one — wrapping
  // changes the layout, composing does not.
  it('becomes the child element with asChild', () => {
    render(
      <Badge asChild variant="secondary">
        <a href="/marketplace">Browse</a>
      </Badge>
    );
    const link = screen.getByRole('link', { name: 'Browse' });
    expect(link).toHaveAttribute('data-slot', 'badge');
    expect(link).toHaveClass('bg-secondary');
  });

  it('defaults to the sm size and takes xs', () => {
    render(
      <>
        <Badge>Default</Badge>
        <Badge size="xs">Tiny</Badge>
      </>
    );
    expect(screen.getByText('Default')).toHaveClass('text-xs');
    expect(screen.getByText('Tiny')).toHaveClass('text-3xs');
  });

  // The pill is the shape four components wanted and could not get, so each
  // drew its own. It has to come OUT of the primitive, not off the call site.
  it('defaults to the rounded rectangle and takes the pill', () => {
    render(
      <>
        <Badge>Boxy</Badge>
        <Badge shape="pill">Round</Badge>
      </>
    );
    expect(screen.getByText('Boxy')).toHaveClass('rounded-md');
    const pill = screen.getByText('Round');
    expect(pill).toHaveClass('rounded-full');
    expect(pill).not.toHaveClass('rounded-md');
  });

  // The tone comes from the app's shared status vocabulary, so a warning badge
  // is the same amber as a warning banner — in both themes.
  it('paints a tone from the shared status tokens', () => {
    render(
      <Badge variant="outline" tone="warning">
        No auth
      </Badge>
    );
    expect(screen.getByText('No auth')).toHaveClass(STATUS_TONE_TEXT.warning);
  });

  // Declaration order is load-bearing: `tone` is a colour correction on top of
  // a shape, so tailwind-merge has to see it after the variant's own colour.
  it('lets a tone beat the variant colour it sits on', () => {
    render(
      <Badge variant="outline" tone="error">
        Failed
      </Badge>
    );
    const badge = screen.getByText('Failed');
    expect(badge).toHaveClass(STATUS_TONE_TEXT.error);
    expect(badge).not.toHaveClass('text-foreground');
  });
});
