import * as React from 'react';
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
 * Renders nothing when nothing is open or the viewport is mobile; crossing into
 * mobile while a panel is open closes it (ideation D2). Geometry persistence
 * rides the primitive's single end-of-gesture callback wired straight to
 * `setPipGeometry`, so no throttling is needed here.
 */
export function PipHost(): React.ReactNode {
  const pipContent = useAppStore((s) => s.pipContent);
  const pipGeometry = useAppStore((s) => s.pipGeometry);
  const closePip = useAppStore((s) => s.closePip);
  const setPipGeometry = useAppStore((s) => s.setPipGeometry);
  const isMobile = useIsMobile();

  // Crossing the mobile breakpoint while a panel is open closes it, instead of
  // leaving stale content behind an invisible (null-rendering) host.
  React.useEffect(() => {
    if (isMobile && pipContent !== null) closePip();
  }, [isMobile, pipContent, closePip]);

  if (isMobile || pipContent === null) return null;

  // Recomputed each render while ungeometried so a pre-first-gesture window
  // resize keeps the dock pinned to the corner rather than going stale. Nothing
  // is written to the store until the user's first drag/resize commits.
  const geometry = pipGeometry ?? defaultGeometry();

  return (
    <FloatingPanel
      title={pipContent.title}
      geometry={geometry}
      onGeometryChange={setPipGeometry}
      onClose={closePip}
      // onRestore is undefined for `demo` (no restore target in v1); DOR-297
      // wires "send back to inline/canvas" here per ideation decision D8.
    >
      {renderPipContent(pipContent)}
    </FloatingPanel>
  );
}
