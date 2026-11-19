/**
 * CI-only host page for the browser chrome tooltip witness (DOR-4427).
 *
 * Renders the client's real `BrowserChrome` over the client's real surface hook,
 * wired the way the Agent browser wires them: each chrome tooltip asks for a
 * still of the native page first, and opens only once it is drawn. The witness
 * picks the theme and whether an agent is driving. Bundled by
 * `smoke-local-browser.ts` against the client's own modules; never shipped.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserChrome } from '@/layers/shared/ui/browser-chrome';
import {
  useNativeBrowserSurface,
  type NativeStillControls,
} from '@/layers/features/local-browser/model/use-native-browser-surface';

/** What the witness sets before each set of frames. */
interface Scene {
  dark: boolean;
  agentDriving: boolean;
}

const noop = () => {};

// Keep witness-only timing evidence: a failed hover must distinguish a missing
// pointer event from a still the real surface hook could not prepare in time.
const diagnostics: Record<string, unknown>[] = [];
(window as unknown as { __tooltipDiagnostics: typeof diagnostics }).__tooltipDiagnostics =
  diagnostics;
const record = (event: string, details: Record<string, unknown> = {}) => {
  diagnostics.push({ event, at: performance.now(), ...details });
};
for (const event of ['pointerover', 'pointerout', 'pointermove', 'focusin', 'focusout']) {
  document.addEventListener(event, (input) => {
    if (!(input.target instanceof Element) || !input.target.closest('button[aria-label="Back"]'))
      return;
    record(event);
  });
}

function Witness() {
  const surface = useRef<HTMLDivElement | null>(null);
  const [scene, setScene] = useState<Scene>({ dark: false, agentDriving: false });
  (window as unknown as { __scene: (next: Scene) => void }).__scene = (next) => {
    record('scene', { ...next });
    document.documentElement.classList.toggle('dark', next.dark);
    setScene(next);
  };
  const controls = useRef<NativeStillControls | null>(null);
  const keep = useCallback((next: NativeStillControls | null) => {
    controls.current = next;
  }, []);
  const tooltipStill = useMemo(
    () => ({
      prepare: async () => {
        const started = performance.now();
        record('prepare-start', { controls: controls.current !== null });
        const drawn = await (controls.current?.prepare() ?? Promise.resolve(false));
        record('prepare-end', { drawn, durationMs: performance.now() - started });
        return drawn;
      },
      release: () => {
        record('release');
        controls.current?.release();
      },
    }),
    []
  );
  const still = useNativeBrowserSurface(surface, 'chrome-tooltip-witness', true, noop, keep);
  return (
    // The Agent browser panel: the right half of the window, chrome over the page.
    <div
      className="bg-background text-foreground"
      style={{
        position: 'fixed',
        top: 0,
        bottom: 0,
        left: '50%',
        right: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <BrowserChrome
        url="https://www.example.com/pricing"
        canBack
        canForward={false}
        onBack={noop}
        onForward={noop}
        onReload={noop}
        onSubmit={noop}
        agentDriving={scene.agentDriving}
        tooltipStill={tooltipStill}
      />
      <div
        ref={surface}
        data-slot="native-browser-surface"
        style={{ position: 'relative', flex: 1 }}
      >
        {still && (
          <img
            alt=""
            data-slot="native-browser-still"
            src={still.url}
            style={{
              position: 'absolute',
              left: still.left,
              top: still.top,
              width: still.width,
              height: still.height,
            }}
          />
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Witness />);
