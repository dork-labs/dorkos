/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { TabStatusMark } from '../ui/TabStatusMark';

function countBadge(identity: Parameters<typeof TabStatusMark>[0]['identity']) {
  const { container } = render(<TabStatusMark identity={identity} />);
  return container.querySelector('[data-slot="tab-count"]');
}

describe('TabStatusMark', () => {
  it('fills a count that needs you in the warning colour', () => {
    const badge = countBadge({ status: 'needs-you', count: 2, countEmphasis: true });
    expect(badge?.className).toContain('bg-status-warning-dot');
  });

  it('fills a count of failures red, as a failed dot would be', () => {
    const badge = countBadge({ status: 'failed', count: 1, countEmphasis: true });
    expect(badge?.className).toContain('bg-status-error');
    expect(badge?.className).not.toContain('bg-status-warning-dot');
  });

  it('keeps a count that is only activity quiet', () => {
    const badge = countBadge({ status: 'new', count: 5, countEmphasis: false });
    expect(badge?.className).not.toMatch(/bg-status-(error|warning-dot)/);
  });
});
