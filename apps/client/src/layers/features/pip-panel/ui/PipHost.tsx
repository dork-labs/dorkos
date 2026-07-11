import * as React from 'react';
import { AnimatePresence } from 'motion/react';
import { FloatingPanel, type FloatingPanelGeometry } from '@/layers/shared/ui';
import { useAppStore, useIsMobile, type PipContent } from '@/layers/shared/model';
import { DemoPipContent } from './DemoPipContent';

/** Default panel size and edge margin used to dock in the bottom-right corner. */
const DEFAULT_WIDTH = 360;
const DEFAULT_HEIGHT = 240;
const DEFAULT_MARGIN = 16;

/**
 * Map of PIP content kind → renderer component. Declared at module scope on
 * purpose: a renderer recreated inside the component body gets a fresh identity
 * every render, which React treats as a different component type and
 * unmounts/remounts the whole subtree — the same hazard documented for
 * `DorkosUiFence` in `features/chat/ui/message/StreamingText.tsx`. Keeping the
 * map stable matters the moment DOR-298 puts a live, stateful widget inside:
 * a remount on every parent re-render would destroy its in-flight state.
 */
const PIP_RENDERERS: {
  demo: React.ComponentType<{ content: Extract<PipContent, { kind: 'demo' }> }>;
} = {
  demo: DemoPipContent,
};

/** Compute the default bottom-right dock for a panel that has no saved geometry. */
function defaultGeometry(): FloatingPanelGeometry {
  return {
    x: window.innerWidth - DEFAULT_WIDTH - DEFAULT_MARGIN,
    y: window.innerHeight - DEFAULT_HEIGHT - DEFAULT_MARGIN,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  };
}

/** Value equality for geometries, used to keep the dock's object identity stable. */
function sameGeometry(a: FloatingPanelGeometry, b: FloatingPanelGeometry): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Render the body for a PIP content descriptor via {@link PIP_RENDERERS}. */
function renderPipContent(content: PipContent): React.ReactNode {
  switch (content.kind) {
    case 'demo': {
      const Renderer = PIP_RENDERERS.demo;
      return <Renderer content={content} />;
    }
    default: {
      // Exhaustive check — adding a kind without a case is a compile error here,
      // forcing DOR-297/298 to register their renderer before shipping.
      const _exhaustive: never = content.kind;
      return _exhaustive;
    }
  }
}

/**
 * Singleton host that routes the current serializable {@link PipContent}
 * descriptor to its renderer inside the shared floating-panel primitive. Mounts
 * once at the tail of each client shell, outside the router-swapped subtree, so
 * a floating panel survives navigation.
 *
 * The panel conditionally renders INSIDE an always-mounted `AnimatePresence`
 * boundary so the primitive's ~150ms exit animation plays on close; the mobile
 * guard sits outside it on purpose — crossing the breakpoint closes instantly
 * (ideation D2), the animated exit matters for the normal close affordance.
 *
 * Geometry persistence rides the primitive's single end-of-gesture callback
 * wired straight to `setPipGeometry`, so no throttling is needed here.
 */
export function PipHost(): React.ReactNode {
  const pipContent = useAppStore((s) => s.pipContent);
  const pipGeometry = useAppStore((s) => s.pipGeometry);
  const closePip = useAppStore((s) => s.closePip);
  const setPipGeometry = useAppStore((s) => s.setPipGeometry);
  const isMobile = useIsMobile();

  // The default bottom-right dock, used until the user's first drag/resize
  // commits a real geometry to the store. Held in state (not recomputed per
  // render) so its object identity is stable across unrelated re-renders —
  // a fresh object each render would make FloatingPanel's reclamp effect
  // (which depends on `geometry`) tear down and re-add its window listener
  // on every re-render.
  const [dockGeometry, setDockGeometry] = React.useState<FloatingPanelGeometry>(defaultGeometry);

  // Keep the dock pinned to the corner while ungeometried: re-pin on window
  // resize, and once on (re)attach in case the window changed while a
  // committed geometry was in effect (e.g. until a preferences reset). The
  // functional updater returns the previous object when nothing changed, so
  // this never causes render churn.
  React.useEffect(() => {
    if (pipGeometry !== null) return;
    const repin = () =>
      setDockGeometry((prev) => {
        const next = defaultGeometry();
        return sameGeometry(prev, next) ? prev : next;
      });
    repin();
    window.addEventListener('resize', repin);
    return () => window.removeEventListener('resize', repin);
  }, [pipGeometry]);

  // Crossing the mobile breakpoint while a panel is open closes it, instead of
  // leaving stale content behind an invisible (null-rendering) host.
  React.useEffect(() => {
    if (isMobile && pipContent !== null) closePip();
  }, [isMobile, pipContent, closePip]);

  // Instant, unanimated removal below the breakpoint by design (see TSDoc).
  if (isMobile) return null;

  const geometry = pipGeometry ?? dockGeometry;

  return (
    <AnimatePresence>
      {pipContent !== null && (
        <FloatingPanel
          key="pip-panel"
          title={pipContent.title}
          geometry={geometry}
          onGeometryChange={setPipGeometry}
          onClose={closePip}
          // onRestore is undefined for `demo` (no restore target in v1); DOR-297
          // wires "send back to inline/canvas" here per ideation decision D8.
        >
          {renderPipContent(pipContent)}
        </FloatingPanel>
      )}
    </AnimatePresence>
  );
}
