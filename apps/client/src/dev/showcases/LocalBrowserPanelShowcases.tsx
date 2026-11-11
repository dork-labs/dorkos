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

/**
 * A scoped transport for a browser that was never opened.
 *
 * @param forget - What Forget does; the playground's own by default.
 */
function notOpenTransport(forget?: () => Promise<never>): Transport {
  const base = createPlaygroundTransport();
  return new Proxy(base, {
    get: (target, prop, receiver) => {
      if (prop === 'getLocalBrowserState') return async () => NOT_OPEN;
      if (prop === 'getLocalBrowserCapabilities')
        return async () => ({ embedded: false, newWindow: true });
      if (prop === 'listLocalBrowserProfiles') return async () => ({ profiles: [] });
      if (prop === 'forgetLocalBrowserSignIns' && forget) return forget;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

/** The panel reading a browser that was never opened, from a scoped transport. */
function NotOpenDemo() {
  const [transport] = useState<Transport>(() => notOpenTransport());
  return (
    <TransportProvider transport={transport}>
      <div className="bg-background h-[36rem] w-full max-w-sm rounded-lg border">
        <LocalBrowserPanel sessionId="chat-atlas" agentName="Atlas" />
      </div>
    </TransportProvider>
  );
}

/**
 * Forget refused because the sign-ins folder was changed outside DorkOS (DOR-4172).
 * Press Forget… then Forget sign-ins to see the line, which offers no Try again.
 */
function FolderChangedDemo() {
  const [transport] = useState<Transport>(() =>
    notOpenTransport(async () => {
      throw Object.assign(new Error('Sign-ins weren’t forgotten.'), {
        code: 'profiles_folder_changed',
      });
    })
  );
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
      <ShowcaseLabel>Forget refused: the sign-ins folder was changed outside DorkOS</ShowcaseLabel>
      <ShowcaseDemo>
        <FolderChangedDemo />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
