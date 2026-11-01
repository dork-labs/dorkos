/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TabStatusMark } from '../ui/TabStatusMark';

function countBadge(identity: Parameters<typeof TabStatusMark>[0]['identity']) {
  const { container } = render(<TabStatusMark identity={identity} />);
  return container.querySelector('[data-slot="tab-count"]');
}

describe('TabStatusMark', () => {
  it('fills a count that needs you in the warning colour', () => {
    const badge = countBadge({ status: 'needs-you', count: 2, countTone: 'warning' });
    expect(badge).toHaveAttribute('data-tone', 'warning');
    expect(badge?.className).toContain('bg-dui-status-warning-bg');
  });

  it('draws a count of failures red, as a failed dot would be', () => {
    const badge = countBadge({ status: 'failed', count: 1, countTone: 'error' });
    expect(badge?.className).toContain('bg-dui-status-error-bg');
    expect(badge?.className).not.toContain('status-warning');
  });

  it('draws a DM or a mention in orange, because orange means you', () => {
    const badge = countBadge({ count: 3, countTone: 'you' });
    expect(badge?.className).toContain('bg-dui-brand/15');
  });

  it('keeps a count that is only activity quiet', () => {
    const badge = countBadge({ status: 'new', count: 5, countTone: 'neutral' });
    expect(badge?.className).not.toMatch(/bg-status-|bg-brand/);
  });

  it('caps at 99+ and leaves the number to the tab name', () => {
    const badge = countBadge({ count: 140 });
    expect(badge).toHaveTextContent('99+');
    expect(badge).toHaveAttribute('aria-hidden', 'true');
  });
});
