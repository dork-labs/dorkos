import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { Button } from '@/layers/shared/ui';
import { useAppStore } from '@/layers/shared/model';
import { PipHost } from '@/layers/features/pip-panel';

/**
 * PIP Panel showcase — the Dev Playground never mounts `AppShell`/`App.tsx`,
 * so this showcase mounts `<PipHost />` itself (once) so the `openPip` calls
 * below have something to render into. There is no end-user entry point for
 * the floating-panel primitive in v1 (DOR-297/298 add real consumers later),
 * so this showcase IS the verification surface — drive it by hand rather than
 * looking for automated coverage here.
 */
export function PipPanelShowcases() {
  return (
    <>
      <PlaygroundSection
        title="FloatingPanel"
        description="Draggable, resizable mini-window that floats above the app and remembers where you left it."
      >
        <ShowcaseDemo>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                onClick={() =>
                  useAppStore.getState().openPip({ kind: 'demo', title: 'Demo panel A' })
                }
              >
                Open Demo A
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  useAppStore.getState().openPip({ kind: 'demo', title: 'Demo panel B' })
                }
              >
                Open Demo B
              </Button>
              <Button variant="outline" onClick={() => useAppStore.getState().closePip()}>
                Close
              </Button>
            </div>
            <p className="text-muted-foreground text-sm">
              Open Demo A, then Open Demo B — the second call replaces the first, since only one
              panel shows at a time. Drag the panel by its header and resize it from the
              bottom-right corner to check that it clamps against the viewport edges. Reload the{' '}
              <code className="bg-muted rounded px-1 py-0.5 text-xs">/dev/features</code> page
              afterward to confirm the position survives: geometry persists to localStorage, the
              same way it does in the real app.
            </p>
            <p className="text-muted-foreground text-sm">
              Mobile: narrow the viewport below 768px (DevTools device toolbar) and the same demo
              button opens the PIP as a non-modal bottom sheet instead of a floating panel. It opens
              at the 0.5 peek snap; drag the handle up to the 0.94 expanded snap, or drag down past
              peek to minimize into the 64px mini-bar (tap it to restore; its X closes). The content
              behind the sheet stays scrollable and clickable (no overlay, no background scaling),
              and the mini-bar pads the page bottom via --pip-dock so nothing is covered.
            </p>
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>
      <PipHost />
    </>
  );
}
