/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ConnectorConnectionSummary } from '@dorkos/shared/connector-resource-schemas';
import { toImpactApp } from '../lib/connection-impact';
import { ConnectionImpactList } from '../ui/ConnectionImpactList';

afterEach(cleanup);

function summary(over: Partial<ConnectorConnectionSummary>): ConnectorConnectionSummary {
  return {
    connectionId: 'c1' as never,
    providerInstanceId: 'p1' as never,
    toolkit: 'google_calendar',
    label: 'work',
    identityHint: null,
    lifecycle: 'connected',
    authenticationStatus: 'active',
    reconciliationStatus: 'ready',
    authoritySync: { status: 'ready' },
    mode: 'managed',
    custody: 'managed',
    payer: 'dorkos_managed',
    agentCount: 0,
    everyAgent: null,
    subscriptionCount: 0,
    usage: { status: 'available', logicalOperationCount: 0, attemptCount: 0 },
    warnings: [],
    ...over,
  };
}

describe('ConnectionImpactList', () => {
  it('names the app with the shared rule and says when every agent uses it', () => {
    const shared = toImpactApp(
      summary({ everyAgent: { operationRevisionIds: ['r1'], classifications: ['read'] } })
    );
    const named = toImpactApp(
      summary({ connectionId: 'c2' as never, toolkit: 'gmail', agentCount: 2 })
    );
    render(<ConnectionImpactList stopping={[shared, named]} idle={[]} stopLine="These stop:" />);

    expect(screen.getByText(/Google Calendar \(work\)/)).toHaveTextContent(
      'Google Calendar (work) · used by every agent'
    );
    expect(screen.getByText(/Gmail \(work\)/)).toHaveTextContent('Gmail (work) · used by 2 agents');
  });
});
