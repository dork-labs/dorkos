import { useLayoutEffect, useState } from 'react';
import type {
  BrowserProductionTransport,
  BrowserViewerTransport,
  BrowserInputTransport,
  BrowserSemanticTransport,
} from '@dorkos/shared/transport';
import { useConfig } from '@/layers/entities/config';
import { useAuthSession } from '@/layers/features/auth';
import { ManagedBrowserWorkspace } from '@/layers/features/managed-browser';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { Button, PageContainer, PageHeading } from '@/layers/shared/ui';

/** The experiment controls visibility. Every operation still needs genuine server authority. */
export function BrowserPage() {
  const config = useConfig();
  const auth = useAuthSession();
  const transport = useTransport();
  const openSettings = useAppStore((state) => state.setSettingsOpen);
  const enabled =
    config.data?.experiments?.some(
      ({ key, enabled: chosen }) => key === 'browser.enabled' && chosen
    ) === true;
  const session = auth.data;
  const delivery = transport.browserViewerDelivery;
  const input = transport.browserInput;
  const production = transport.browserProduction;
  return (
    <PageContainer width="full">
      <PageHeading>Shared browser</PageHeading>
      {config.isError || auth.isError ? (
        <p role="alert">Browser settings or sign-in could not be checked. Refresh this page.</p>
      ) : config.isPending || auth.isPending ? (
        <p role="status">Loading browser settings…</p>
      ) : !enabled ? (
        <div className="space-y-3">
          <p>Shared browser is an experiment. Turn it on in Settings → Experiments to try it.</p>
          <Button variant="outline" onClick={() => openSettings(true)}>
            Open settings
          </Button>
        </div>
      ) : !session ? (
        <p role="status">Sign in to use the shared browser.</p>
      ) : !production || !delivery || !input ? (
        <p role="status">The shared browser is not available in this app yet.</p>
      ) : (
        <AuthenticatedBrowserWorkspace
          key={session.user.id + ':' + session.session.id}
          cacheOwner={session.user.id}
          production={production}
          viewer={delivery}
          input={input}
          semantic={transport.browserSemantic}
        />
      )}
    </PageContainer>
  );
}

/** Effect-born viewer scope survives development effect replay without reviving an aborted original. */
function AuthenticatedBrowserWorkspace(props: {
  cacheOwner: string;
  production: BrowserProductionTransport;
  viewer: BrowserViewerTransport;
  input: BrowserInputTransport;
  semantic?: BrowserSemanticTransport;
}) {
  const [scope, setScope] = useState<{
    id: string;
    controller: AbortController;
  }>();
  useLayoutEffect(() => {
    const original = new AbortController();
    setScope({ id: crypto.randomUUID(), controller: original });
    return () => original.abort();
  }, []);
  return scope ? (
    <ManagedBrowserWorkspace key={scope.id} {...props} lossSignal={scope.controller.signal} />
  ) : null;
}
