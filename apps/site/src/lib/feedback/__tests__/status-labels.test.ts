import { describe, expect, it } from 'vitest';

import { feedbackStatusLabel } from '../status-labels';

describe('feedbackStatusLabel', () => {
  it('labels every status per the design-decisions vocabulary', () => {
    expect(feedbackStatusLabel('received')).toBe('Received');
    expect(feedbackStatusLabel('triaged')).toBe('Triaged');
    expect(feedbackStatusLabel('in_progress')).toBe('In progress');
    expect(feedbackStatusLabel('closed')).toBe('Closed');
  });

  it('includes the version when shipped', () => {
    expect(feedbackStatusLabel('shipped', '0.56.3')).toBe('Shipped v0.56.3');
  });

  it('falls back to a bare "Shipped" when no version is known', () => {
    expect(feedbackStatusLabel('shipped', null)).toBe('Shipped');
    expect(feedbackStatusLabel('shipped', undefined)).toBe('Shipped');
  });
});
