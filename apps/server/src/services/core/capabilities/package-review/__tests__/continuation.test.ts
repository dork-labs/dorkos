import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPackageReviewContinuations } from '../continuation.js';

const scope = {
  capabilityId: 'marketplace.install',
  sessionId: 'sample-session',
  agentPath: '/sample/scout',
  input: {
    name: 'sample-pack',
    projectPath: '/sample/project',
    nested: { confirmationToken: 'nested-value' },
  },
};
const approval = { via: 'approval' as const, approvalId: 'sample-approval' };
const pending = { status: 'requires_confirmation', confirmationToken: 'content-token' };
const retry = { ...scope, input: { ...scope.input, confirmationToken: pending.confirmationToken } };

/** A real one-shot permission ask followed by a pending content card. */
function prepared() {
  const records = createPackageReviewContinuations();
  records.asked(scope, approval.approvalId, new Date(Date.now() + 1000).toISOString());
  records.remember(scope, pending, approval);
  return records;
}
afterEach(() => vi.useRealTimers());

describe('package review continuation', () => {
  it('carries one grant across the top-level content-token difference, once', () => {
    const records = prepared();
    expect(records.take(retry)?.approval).toEqual(approval);
    expect(records.take(retry)).toBeUndefined();
  });
  it.each([
    { ...retry, input: { ...retry.input, name: 'another-pack' } },
    { ...retry, input: { ...retry.input, projectPath: '/another/project' } },
    {
      ...retry,
      input: { ...retry.input, nested: { confirmationToken: 'different-nested-value' } },
    },
    { ...retry, sessionId: 'another-session' },
    { ...retry, agentPath: '/sample/another-agent' },
    { ...retry, capabilityId: 'marketplace.create_package' },
    { ...retry, capabilityId: 'another.install' },
    { ...retry, sessionId: undefined },
  ])('keeps every other field and caller scope exact: %j', (changed) => {
    const records = prepared();
    expect(records.take(changed)).toBeUndefined();
    expect(records.take(retry)).toBeDefined();
  });
  it('refuses a forged content token without spending the real continuation', () => {
    const records = prepared();
    expect(
      records.take({ ...retry, input: { ...retry.input, confirmationToken: 'forged' } })
    ).toBeUndefined();
    expect(records.take(retry)).toBeDefined();
  });
  it('expires with the original permission ask', () => {
    vi.useFakeTimers();
    const records = prepared();
    vi.advanceTimersByTime(1001);
    expect(records.take(retry)).toBeUndefined();
  });
  it('does not create a continuation from a standing grant', () => {
    const records = createPackageReviewContinuations();
    records.asked(scope, approval.approvalId, new Date(Date.now() + 1000).toISOString());
    records.remember(scope, pending, { via: 'permission', source: 'agent-action' });
    expect(records.take(retry)).toBeUndefined();
  });
  it('requires the one-shot ask to have come from the same session', () => {
    const records = createPackageReviewContinuations();
    records.asked(
      { ...scope, sessionId: 'another-session' },
      approval.approvalId,
      new Date(Date.now() + 1000).toISOString()
    );
    records.remember(scope, pending, approval);
    expect(records.take(retry)).toBeUndefined();
  });
  it('does not extend the original deadline when the content card is still pending', () => {
    vi.useFakeTimers();
    const records = prepared();
    const previous = records.take(retry)!;
    vi.advanceTimersByTime(500);
    records.remember(retry, pending, approval, previous);
    vi.advanceTimersByTime(501);
    expect(records.take(retry)).toBeUndefined();
  });
});
