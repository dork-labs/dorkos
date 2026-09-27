/**
 * Connections settings — how DorkOS reaches your apps, and how chat apps behave
 * when a message arrives (DOR-2419, design record `connections-one-list` §7).
 *
 * Rule of thumb: the Connections page is for apps, this tab is for the
 * plumbing. Both sections belong to `features/connections` and are composed
 * here (sibling UI composition); this file only wires them to the two places
 * they send people: Settings › Access for the DorkOS account link, and the
 * Connections page for the apps themselves.
 *
 * @module features/settings/ui/tabs/ConnectionsTab
 */
import { ChatAppSettings, ConnectionWays } from '@/layers/features/connections';
import { useDeepLinkScroll, useOpenConnections, useSettingsDeepLink } from '@/layers/shared/model';
import { Button, useNavigationLayout } from '@/layers/shared/ui';

/** Settings › Connections. */
export function ConnectionsTab() {
  const settings = useSettingsDeepLink();
  const navigation = useNavigationLayout();
  const openConnections = useOpenConnections();
  useDeepLinkScroll(settings.section);

  const openConnectionsPage = () => {
    settings.close();
    openConnections('accounts');
  };

  return (
    <div className="space-y-8">
      {/* No heading: the Settings dialog draws the panel's own header. */}
      <p className="text-muted-foreground text-xs">
        How DorkOS reaches your apps, and how chat apps behave. Your apps themselves are on the{' '}
        <Button variant="link" className="h-auto p-0 text-xs" onClick={openConnectionsPage}>
          Connections page
        </Button>
        .
      </p>

      <section data-section="ways" aria-labelledby="settings-connection-ways" className="space-y-3">
        <h3
          id="settings-connection-ways"
          className="text-muted-foreground text-xs font-semibold tracking-wide uppercase"
        >
          How DorkOS reaches your apps
        </h3>
        <ConnectionWays
          onManageAccount={() => {
            // The tab switch is the dialog's own state; the section is the
            // URL's, and Access scrolls to it when it mounts.
            navigation.onValueChange('access');
            settings.setSection('account');
          }}
          onOpenConnectionsPage={openConnectionsPage}
        />
      </section>

      <section data-section="chat-apps" aria-labelledby="settings-chat-apps" className="space-y-3">
        <h3
          id="settings-chat-apps"
          className="text-muted-foreground text-xs font-semibold tracking-wide uppercase"
        >
          Chat apps
        </h3>
        <ChatAppSettings />
      </section>
    </div>
  );
}
