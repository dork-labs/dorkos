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
        {/* Not drawn (design decision E1): the bar overhead already says
            "Connections", and repeating it spends a row on a word that is
            on screen. The heading stays for the outline — the bar's title
            is a `nav` landmark, not a heading, so it cannot stand in for
            one, and a page with no `h1` leaves its sections hanging under
            nothing for anyone navigating by heading. */}
        <h1 className="sr-only">Connections</h1>
        <p className="text-muted-foreground max-w-prose text-sm">
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
