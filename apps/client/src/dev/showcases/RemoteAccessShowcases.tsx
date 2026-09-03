import { useEffect } from 'react';
import { Button } from '@/layers/shared/ui';
import {
  resetRemoteAccessStore,
  useRemoteAccessStore,
  type TunnelState,
} from '@/layers/entities/tunnel';
import { RemoteAccessRow } from '@/layers/widgets/control-center';
import { RemoteAccessBeacon, RemoteAccessPanel } from '@/layers/widgets/remote-access';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';

const DEMO_URL = 'https://calm-otter.ngrok.app';

/**
 * Put the shared model in one of its states, the way an action would.
 *
 * Every button below drives the REAL store through the REAL store actions, so
 * what the playground draws is what the app draws — a gallery of hand-posed
 * copies would go stale the first time a state's copy changed.
 */
const STATES: { label: string; drive: () => void }[] = [
  // First, and the state the page opens in: the playground's transport reports
  // no tunnel at all, which is exactly "nothing set up yet".
  { label: 'Never set up', drive: () => resetRemoteAccessStore() },
  { label: 'Off', drive: () => setUp() },
  { label: 'Connecting', drive: () => setUp().beginStart() },
  { label: 'On', drive: () => setUp().settleStart(DEMO_URL) },
  { label: 'Reconnecting', drive: () => setUp().convergeStart(DEMO_URL) },
  { label: 'Turning off', drive: () => setUp().beginStop() },
  {
    label: 'Failed',
    drive: () => setUp().failStart('ERR_NGROK_105 invalid auth token'),
  },
];

/**
 * Pretend the one-time ngrok setup is done, and hand back the store's actions.
 *
 * Every state except the first needs it: the playground's transport reports no
 * tunnel block, so the shared model correctly reads "no token saved" and the
 * row would offer setup instead of a switch.
 */
function setUp() {
  const store = useRemoteAccessStore.getState();
  store.noteTokenConfigured(true);
  return store;
}

/** The buttons that pose the shared model, plus what it currently says. */
function StateDriver() {
  const state = useRemoteAccessStore((s) => s.state);
  const tokenConfigured = useRemoteAccessStore((s) => s.tokenConfigured);

  // The store is module-scope and outlives this page, so whatever state the
  // last visitor left it posed in does not follow them to the next showcase.
  useEffect(() => () => resetRemoteAccessStore(), []);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {STATES.map((entry) => (
        <Button key={entry.label} variant="outline" size="sm" onClick={entry.drive}>
          {entry.label}
        </Button>
      ))}
      <span className="text-muted-foreground ml-2 font-mono text-xs">
        state: {state} · set up: {String(tokenConfigured)}
      </span>
    </div>
  );
}

/**
 * Remote access in the app's chrome (DOR-1743) — the Control Center's top row
 * and the top-bar beacon, driven through every state they can reach.
 *
 * The two surfaces are shown TOGETHER on purpose: they read one shared model,
 * and the bug this design exists to prevent is the row and the beacon
 * disagreeing. Press a state and both should move at once.
 */
export function RemoteAccessShowcases() {
  return (
    <PlaygroundSection
      title="Remote Access"
      description="The Control Center's Remote-access row and the top-bar beacon, on the one shared model. Press a state: both surfaces move together, the beacon appears only while a tunnel is starting, on, or reconnecting, and it draws nothing at all otherwise."
    >
      <ShowcaseLabel>Drive the state</ShowcaseLabel>
      <ShowcaseDemo>
        <StateDriver />
      </ShowcaseDemo>

      <ShowcaseLabel>The Control Center row</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="max-w-sm">
          <RemoteAccessRow />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>The beacon, in a stand-in top bar</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="border-border flex h-9 items-center justify-end gap-1 rounded-md border px-2">
          <RemoteAccessBeacon />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        What the beacon opens — QR first on a desktop, link first on a phone (narrow the window to
        see the flip)
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="border-border w-72 rounded-lg border p-3">
          <RemoteAccessPanel onClose={() => {}} />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
