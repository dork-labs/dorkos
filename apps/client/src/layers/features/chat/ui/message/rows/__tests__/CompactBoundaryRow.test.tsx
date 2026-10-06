/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { CompactBoundaryRow } from '../CompactBoundaryRow';

describe('CompactBoundaryRow', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the pre→post token summary and the trigger badge', () => {
    render(<CompactBoundaryRow trigger="manual" preTokens={52000} postTokens={8000} />);
    expect(screen.getByTestId('compact-boundary-row')).toBeInTheDocument();
    expect(screen.getByText('Compacted context · 52.0k → 8.0k tokens')).toBeInTheDocument();
    expect(screen.getByTestId('compact-boundary-trigger')).toHaveTextContent('manual');
  });

  it('summarizes from preTokens alone when postTokens is absent', () => {
    render(<CompactBoundaryRow trigger="auto" preTokens={840} />);
    expect(screen.getByText('Compacted context · 840 tokens summarized')).toBeInTheDocument();
    expect(screen.getByTestId('compact-boundary-trigger')).toHaveTextContent('auto');
  });

  it('omits the trigger badge when no trigger is known', () => {
    render(<CompactBoundaryRow preTokens={1000} />);
    expect(screen.queryByTestId('compact-boundary-trigger')).not.toBeInTheDocument();
  });

  it('renders the failed state with the error detail', () => {
    render(<CompactBoundaryRow failed error="summarization failed" />);
    const row = screen.getByTestId('compact-boundary-row');
    expect(row).toHaveAttribute('data-failed', 'true');
    expect(screen.getByText('Couldn’t compact')).toBeInTheDocument();
    expect(screen.getByText('summarization failed')).toBeInTheDocument();
  });

  it('says the agent asked, and how full the conversation was (DOR-2732)', () => {
    render(
      <CompactBoundaryRow
        trigger="manual"
        preTokens={178000}
        postTokens={9000}
        requestedBy="agent"
        contextPercent={89}
      />
    );
    const row = screen.getByTestId('compact-boundary-row');
    expect(row).toHaveAttribute('data-requested-by', 'agent');
    expect(screen.getByText('Summarized at 89% (asked by the agent)')).toBeInTheDocument();
    // Who asked is the whole story; the person/runtime trigger badge would contradict it.
    expect(screen.queryByTestId('compact-boundary-trigger')).not.toBeInTheDocument();
  });

  it('still says the agent asked when no reading was taken', () => {
    render(<CompactBoundaryRow requestedBy="agent" />);
    expect(screen.getByText('Summarized (asked by the agent)')).toBeInTheDocument();
  });
});
