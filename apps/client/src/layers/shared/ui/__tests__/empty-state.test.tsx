/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { Inbox } from 'lucide-react';
import { EmptyState } from '../empty-state';
import { QueryErrorState } from '../query-error-state';

afterEach(cleanup);

describe('EmptyState', () => {
  it('says what is missing and what would fill it', () => {
    render(
      <EmptyState
        icon={Inbox}
        headline="No messages yet"
        description="Anything your agents send you lands here."
      />
    );
    expect(screen.getByText('No messages yet')).toBeInTheDocument();
    expect(screen.getByText('Anything your agents send you lands here.')).toBeInTheDocument();
  });

  it('offers no button when there is no way out', () => {
    render(<EmptyState icon={Inbox} headline="Nothing" description="Nothing at all." />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('runs the action when its button is pressed', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <EmptyState
        icon={Inbox}
        headline="Nothing"
        description="Nothing at all."
        action={{ label: 'Reset filters', onClick }}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  // The whole point of the `tone` axis: a failed panel is this component in
  // different colours, not a second component.
  it('paints the destructive tone on the icon box', () => {
    const { container } = render(
      <EmptyState icon={Inbox} headline="Broke" description="It broke." tone="destructive" />
    );
    expect(container.querySelector('.bg-destructive\\/10')).toBeInTheDocument();
  });

  it('renders a preview above the headline', () => {
    render(
      <EmptyState
        icon={Inbox}
        headline="Nothing"
        description="Nothing at all."
        preview={<span>a sketch</span>}
      />
    );
    expect(screen.getByText('a sketch')).toBeInTheDocument();
  });
});

describe('QueryErrorState', () => {
  it('reports the failure and offers one retry', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(
      <QueryErrorState
        title="Could not load your team"
        description="The DorkOS server did not answer."
        onRetry={onRetry}
      />
    );
    expect(screen.getByText('Could not load your team')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  // A retry already in flight must not be askable again — the old hand-rolled
  // panels each decided this differently, and two of them never did.
  it('waits with a disabled button while the retry runs', () => {
    render(<QueryErrorState title="Broke" description="It broke." onRetry={() => {}} isRetrying />);
    expect(screen.getByRole('button', { name: /Retry/ })).toBeDisabled();
    expect(document.querySelector('[data-slot="spinner"]')).toBeInTheDocument();
  });
});
