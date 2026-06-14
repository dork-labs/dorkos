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
    expect(screen.getByText('Compacted context — 52.0k → 8.0k tokens')).toBeInTheDocument();
    expect(screen.getByTestId('compact-boundary-trigger')).toHaveTextContent('manual');
  });

  it('summarizes from preTokens alone when postTokens is absent', () => {
    render(<CompactBoundaryRow trigger="auto" preTokens={840} />);
    expect(screen.getByText('Compacted context — 840 tokens summarized')).toBeInTheDocument();
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
    expect(screen.getByText('Compaction failed')).toBeInTheDocument();
    expect(screen.getByText('summarization failed')).toBeInTheDocument();
  });
});
