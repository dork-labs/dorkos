import { FieldCard, FieldCardContent } from '@/layers/shared/ui';
import { dorkosAccountApps, useConnectorConnections } from '@/layers/entities/connectors';
import { useHostedCommunities } from '@/layers/features/community-hosting';
import { useCreditsFor } from '../model/use-credits-for';

/**
 * "What's on your account" — everything that would change if this account
 * went away: the runtimes running on its credits, the apps connected through
 * it, and the communities that run on it.
 *
 * Each list is read from the place that owns it, never counted here, so this
 * card cannot disagree with the Connections page or the community switcher.
 * A list that is empty is left out; when all three are, one plain line says
 * so instead of three empty headings.
 */
export function AccountContents() {
  const { rows } = useCreditsFor();
  const connections = useConnectorConnections();
  // Rendered only inside the signed-in account tab, so the link check the
  // switcher needs has already been made by the tab around it.
  const hosted = useHostedCommunities(true);

  const runtimes = rows.filter((row) => row.on).map((row) => row.name);
  const apps = connections.data ? dorkosAccountApps(connections.data.connections) : [];
  const communities = hosted.data?.available ? hosted.data.communities : [];
  const empty = runtimes.length === 0 && apps.length === 0 && communities.length === 0;

  return (
    <FieldCard>
      <FieldCardContent className="space-y-3">
        <p className="text-muted-foreground text-xs tracking-wide uppercase">
          What’s on your account
        </p>
        {empty ? (
          <p className="text-muted-foreground text-sm">
            Nothing yet. Runtimes on your credits, apps you connect through this account and spaces
            that run on it will show up here.
          </p>
        ) : (
          <dl className="space-y-3 text-sm">
            {runtimes.length > 0 && <Contents label="Runtimes on credits" items={runtimes} />}
            {apps.length > 0 && (
              <Contents label="Connected apps" items={apps.map((app) => app.name)} />
            )}
            {communities.length > 0 && (
              <Contents label="Spaces" items={communities.map((community) => community.name)} />
            )}
          </dl>
        )}
      </FieldCardContent>
    </FieldCard>
  );
}

/**
 * One labelled list on the card.
 *
 * @param props.label - What the list holds.
 * @param props.items - The names, as their owners spell them.
 */
function Contents({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="font-medium">{items.join(', ')}</dd>
    </div>
  );
}
