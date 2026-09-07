/**
 * The "Learn more" link on a runtime dependency hint. Its `infoUrl` arrives on
 * the runtime-doctor payload — a TypeScript field, not a validated one — and
 * used to render as a bare `<a href>` with none of the app's link policy in
 * the path (DOR-924).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { toast } from 'sonner';
import { DependencyInstallHint } from '../ui/DependencyInstallHint';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const open = vi.fn();

beforeEach(() => {
  open.mockReset();
  vi.mocked(toast.error).mockReset();
  vi.stubGlobal('open', open);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DependencyInstallHint', () => {
  it('renders nothing without a command or a link', () => {
    const { container } = render(<DependencyInstallHint />);
    expect(container.firstChild).toBeNull();
  });

  it('links to a well-formed docs URL and dispatches it through the seam', () => {
    render(<DependencyInstallHint infoUrl="https://docs.anthropic.com/claude-code" />);

    const link = screen.getByText('Learn more').closest('a');
    expect(link?.getAttribute('href')).toBe('https://docs.anthropic.com/claude-code');

    fireEvent.click(link as HTMLAnchorElement);
    expect(open).toHaveBeenCalledWith(
      'https://docs.anthropic.com/claude-code',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('renders no href for a docs URL naming a scheme the app refuses', () => {
    render(<DependencyInstallHint infoUrl="data:text/html,<script>alert(1)</script>" />);

    const link = screen.getByText('Learn more').closest('a');
    expect(link?.hasAttribute('href')).toBe(false);

    fireEvent.click(link as HTMLAnchorElement);
    expect(open).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });
});
