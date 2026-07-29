import { AccountsList, ProviderSetup, ServiceGrid } from '@/layers/features/connections';

/**
 * The /connections page — connect Gmail, Slack, and other services once, then
 * attach them to sessions so agents can act for you.
 *
 * Service-first by design: the grid of services leads, the connected accounts
 * follow, and the vendor-named provider setup sits last — the only place a
 * provider name leads (connector-completion spec §UX).
 */
export function ConnectionsPage() {
  return (
    <div className="container-default mx-auto px-4 py-6">
      <header className="mb-6">
        <h1 className="text-xl font-semibold">Connections</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Link your accounts once, then attach them to sessions so your agents can act for you.
        </p>
      </header>

      <div className="flex flex-col gap-8">
        <section aria-labelledby="connections-services">
          <h2 id="connections-services" className="mb-3 text-sm font-semibold">
            Services
          </h2>
          <ServiceGrid />
        </section>

        <section aria-labelledby="connections-accounts">
          <h2 id="connections-accounts" className="mb-3 text-sm font-semibold">
            Connected accounts
          </h2>
          <AccountsList />
        </section>

        <section aria-labelledby="connections-providers">
          <h2 id="connections-providers" className="mb-1 text-sm font-semibold">
            Providers
          </h2>
          <p className="text-muted-foreground mb-3 text-sm">
            A provider is the backend that carries your connections. Add its key here; every service
            above runs through it.
          </p>
          <ProviderSetup />
        </section>
      </div>
    </div>
  );
}
