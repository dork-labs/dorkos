import { useEffect, useRef } from 'react';
import { useSearch } from '@tanstack/react-router';
import { PageContainer } from '@/layers/shared/ui';
import { MessagingRegion } from './MessagingRegion';
import { AccountsRegion } from './AccountsRegion';

/**
 * The /connections page: everything outside DorkOS, in one place.
 *
 * Two regions, one scroll. Deliberately not tabs — the two halves ask for two
 * different kinds of trust (who may reach your agents, versus what your agents
 * may do as you), and a tab would hide one of those answers behind a click.
 * Scrolling past both is how a person learns the page has two halves at all.
 *
 * `?region=messaging` or `?region=accounts` scrolls to one of them, which is
 * where every retired deep link into the old messaging dialog now lands.
 */
export function ConnectionsPage() {
  const { region } = useSearch({ from: '/_shell/connections' });
  const messagingRef = useRef<HTMLDivElement>(null);
  const accountsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!region) return;
    const target = region === 'accounts' ? accountsRef.current : messagingRef.current;
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [region]);

  return (
    <PageContainer width="wide">
      <header className="mb-8">
        <h1 className="text-xl font-semibold">Connections</h1>
        <p className="text-muted-foreground mt-1 max-w-prose text-sm">
          Everything outside DorkOS: the ways people reach your agents, and the accounts your agents
          can act on for you.
        </p>
      </header>

      <div className="flex flex-col gap-12">
        <div ref={messagingRef} className="scroll-mt-6">
          <MessagingRegion />
        </div>
        <div ref={accountsRef} className="scroll-mt-6">
          <AccountsRegion />
        </div>
      </div>
    </PageContainer>
  );
}
