import { useState } from 'react';
import type { Transport } from '@dorkos/shared/transport';
import type { LocalBrowserPersonState } from '@dorkos/shared/local-browser';
import { TransportProvider } from '@/layers/shared/model';
import { LocalBrowserPanel } from '@/layers/features/local-browser';
import { createPlaygroundTransport } from '../playground-transport';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/** A browser nobody has opened yet. */
const NOT_OPEN: LocalBrowserPersonState = {
  connectionId: null,
  sessionId: null,
  mode: null,
  status: 'disconnected',
  paused: false,
  tabs: [],
  selectedTabId: null,
  revision: 0,
  preparation: null,
  handoff: null,
  signIn: null,
};

/** The panel reading a browser that was never opened, from a scoped transport. */
function NotOpenDemo() {
  const [transport] = useState<Transport>(() => {
    const base = createPlaygroundTransport();
    return new Proxy(base, {
      get: (target, prop, receiver) => {
        if (prop === 'getLocalBrowserState') return async () => NOT_OPEN;
        if (prop === 'getLocalBrowserCapabilities')
          return async () => ({ embedded: false, newWindow: true });
        if (prop === 'listLocalBrowserProfiles') return async () => ({ profiles: [] });
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
  });
  return (
    <TransportProvider transport={transport}>
      <div className="bg-background h-[36rem] w-full max-w-sm rounded-lg border">
        <LocalBrowserPanel sessionId="chat-atlas" agentName="Atlas" />
      </div>
    </TransportProvider>
  );
}

/**
 * The Agent browser panel before first use (DOR-4104): it says "Not open yet",
 * because "Disconnected" before anything was opened reads as broken.
 */
export function LocalBrowserPanelShowcases() {
  return (
    <PlaygroundSection
      title="Agent browser panel"
      description="The panel beside a chat that picks a browser and shares one page with that chat's agent."
    >
      <ShowcaseLabel>Before the browser was ever opened</ShowcaseLabel>
      <ShowcaseDemo>
        <NotOpenDemo />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
