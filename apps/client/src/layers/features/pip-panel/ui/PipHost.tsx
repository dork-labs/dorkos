import * as React from 'react';
import { AnimatePresence } from 'motion/react';
import { FloatingPanel, type FloatingPanelGeometry } from '@/layers/shared/ui';
import { useAppStore, useIsMobile, type PipContent } from '@/layers/shared/model';
import { McpAppFrame } from '@/layers/features/mcp-apps';
import { LiveSessionWidget } from '@/layers/features/gen-ui';
import { DemoPipContent } from './DemoPipContent';
import { PipMiniBar } from './PipMiniBar';
import { PipSheet } from './PipSheet';

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
 * map stable matters most for `widget` (DOR-298): a remount on every parent
 * re-render would destroy the pinned session's in-flight stream and board
 * state ({@link WidgetPipContent} wraps `LiveSessionWidget`, which owns that
 * lifecycle).
 */
const PIP_RENDERERS: {
  demo: React.ComponentType<{ content: Extract<PipContent, { kind: 'demo' }> }>;
  mcp_app: React.ComponentType<{ content: Extract<PipContent, { kind: 'mcp_app' }> }>;
  widget: React.ComponentType<{ content: Extract<PipContent, { kind: 'widget' }> }>;
} = {
  demo: DemoPipContent,
  mcp_app: McpAppPipContent,
  widget: WidgetPipContent,
};

/**
 * Adapter that maps an `mcp_app` PIP descriptor onto {@link McpAppFrame}'s flat
 * props. Declared at module scope (not inlined into {@link PIP_RENDERERS}) so
 * the frame — which owns its own TanStack Query, postMessage bridge lifecycle,
 * and per-server render consent — keeps a stable component identity and is never
 * torn down by an unrelated parent re-render.
 *
 * @param props.content - The `mcp_app` PIP descriptor to render.
 */
function McpAppPipContent({ content }: { content: Extract<PipContent, { kind: 'mcp_app' }> }) {
  return (
    <McpAppFrame
      sessionId={content.sessionId}
      serverName={content.serverName}
      uri={content.uri}
      title={content.title}
      className="h-full"
    />
  );
}

/**
 * Adapter that maps a `widget` PIP descriptor onto {@link LiveSessionWidget}'s
 * flat props. Declared at module scope (not inlined into {@link PIP_RENDERERS})
 * for the same stable-identity reason as {@link McpAppPipContent} — the
 * pinned session stream and live board underneath must never remount because
 * an unrelated parent re-rendered.
 *
 * @param props.content - The `widget` PIP descriptor to render.
 */
function WidgetPipContent({ content }: { content: Extract<PipContent, { kind: 'widget' }> }) {
  return <LiveSessionWidget sessionId={content.sessionId} />;
}

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
    case 'mcp_app': {
      const Renderer = PIP_RENDERERS.mcp_app;
      return <Renderer content={content} />;
    }
    case 'widget': {
      const Renderer = PIP_RENDERERS.widget;
      return <Renderer content={content} />;
    }
    default: {
      // Exhaustive check — adding a kind without a case is a compile error here,
      // forcing a new PIP content kind to register its renderer before shipping.
      const _exhaustive: never = content;
      return _exhaustive;
    }
  }
}

/**
 * Desktop presenter: routes the descriptor into the shared floating-panel
 * primitive. Owns every geometry concern (the persisted/default dock and the
 * re-pin-on-resize effect) — all desktop-only, so none of it runs on mobile
 * where {@link PipHost} takes the sheet branch instead.
 *
 * The panel conditionally renders INSIDE an always-mounted `AnimatePresence`
 * boundary so the primitive's ~150ms exit animation plays on close. The
 * boundary must stay mounted even when `content` is null-adjacent, so this
 * component is only ever mounted on the desktop path and never behind a
 * higher-up conditional that would unmount `AnimatePresence` outright.
 *
 * Geometry persistence rides the primitive's single end-of-gesture callback
 * wired straight to `setPipGeometry`, so no throttling is needed here.
 *
 * @param props.content - The descriptor to present, or null to play the exit.
 * @param props.onClose - Close handler, wired to `closePip`.
 */
function DesktopPip({
  content,
  onClose,
}: {
  content: PipContent | null;
  onClose: () => void;
}): React.ReactNode {
  const pipGeometry = useAppStore((s) => s.pipGeometry);
  const setPipGeometry = useAppStore((s) => s.setPipGeometry);

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

  const geometry = pipGeometry ?? dockGeometry;

  return (
    <AnimatePresence>
      {content !== null && (
        <FloatingPanel
          key="pip-panel"
          title={content.title}
          geometry={geometry}
          onGeometryChange={setPipGeometry}
          onClose={onClose}
          // onRestore is intentionally omitted for every v1 kind. `demo` has no
          // restore target; `mcp_app` and `widget` both keep their inline block
          // live in the transcript (popping out never removes it, dual-live
          // instances per ideation D5), so close IS the exit — there is nothing
          // to "send back" to. A future kind that owns its only instance would
          // wire a restore target here.
        >
          {renderPipContent(content)}
        </FloatingPanel>
      )}
    </AnimatePresence>
  );
}

/**
 * Singleton host that routes the current serializable {@link PipContent}
 * descriptor to the presenter for the active viewport. Mounts once at the tail
 * of each client shell, outside the router-swapped subtree, so PIP survives
 * navigation.
 *
 * Presenters share one descriptor: {@link DesktopPip} floats it in the shared
 * floating-panel primitive at ≥768px; below 768px it docks as a non-modal
 * bottom sheet ({@link PipSheet}) or, when minimized (Amendment 2), the
 * {@link PipMiniBar}. Crossing the breakpoint swaps presenters with the
 * content intact — no force-close (ideation D2) — and desktop→mobile lands
 * MINIMIZED, so a rotation never suddenly covers half the screen. The swap
 * remounts the content (accepted: a `widget` replays its pinned stream
 * gap-free and the fence latch prevents skeleton flicker; an `mcp_app`
 * reloads its frame, the same cost as a pop-out). Geometry is desktop-only
 * and never crosses over; the minimized flag is mobile-only and desktop
 * ignores it.
 *
 * Both branches keep an always-mounted `AnimatePresence` boundary with the
 * presenter conditionally inside, so each presenter's exit plays on close: the
 * panel's ~150ms fade+scale inside `DesktopPip`, the sheet/bar slide-down here.
 */
export function PipHost(): React.ReactNode {
  const pipContent = useAppStore((s) => s.pipContent);
  const pipMinimized = useAppStore((s) => s.pipMinimized);
  const closePip = useAppStore((s) => s.closePip);
  const minimizePip = useAppStore((s) => s.minimizePip);
  const restorePip = useAppStore((s) => s.restorePip);
  const isMobile = useIsMobile();

  // Desktop→mobile rising edge with content open lands minimized: a rotation
  // or window shrink must never suddenly cover half the screen with the sheet.
  // (Opening ON mobile still presents the sheet — openPip resets the flag.)
  const wasMobileRef = React.useRef(isMobile);
  React.useEffect(() => {
    if (isMobile && !wasMobileRef.current && pipContent !== null) minimizePip();
    wasMobileRef.current = isMobile;
  }, [isMobile, pipContent, minimizePip]);

  if (isMobile) {
    // Sheet or mini-bar renders conditionally INSIDE the boundary (same shape
    // as the desktop path) so the slide-down exit plays when content clears
    // or the presenters swap.
    return (
      <AnimatePresence>
        {pipContent !== null &&
          (pipMinimized ? (
            <PipMiniBar
              key="pip-minibar"
              content={pipContent}
              onRestore={restorePip}
              onClose={closePip}
            />
          ) : (
            <PipSheet
              key="pip-sheet"
              content={pipContent}
              onClose={closePip}
              onMinimize={minimizePip}
            >
              {renderPipContent(pipContent)}
            </PipSheet>
          ))}
      </AnimatePresence>
    );
  }

  // Desktop: DesktopPip stays mounted even when content is null so its
  // always-mounted AnimatePresence can play the panel's exit animation on
  // close (an early null-return here would unmount the boundary and kill it).
  return <DesktopPip content={pipContent} onClose={closePip} />;
}
