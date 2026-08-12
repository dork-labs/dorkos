/**
 * The sidebar's footer: one slim tinted strip (BC-47).
 *
 * It replaces three rows of branding — a logo block, an icon bar and a version
 * line — with a single row that earns its space: the four places DorkOS goes,
 * and a permanent way to ask DorkBot for help.
 *
 * **Separation is tint, never a line.** The strip sits one step up the
 * `--sidebar-accent` ramp from the panel, which is the same perceptual direction
 * in both themes; `--muted` is banned here because it is lighter than the panel
 * in light mode and darker in dark, so the seam would flip between themes (spec
 * R1). There is no `border-t` in this subtree, deliberately.
 *
 * **The version number is gone from the chrome** (BC-44). It lives in the header
 * block's menu and in what DorkBot is told when you ask it something. What is
 * left is the one version fact that is actionable: a transient pill, present
 * only while an update genuinely is ready. Updates never enter Heads up — Heads up means
 * your agents need you.
 *
 * @module features/dashboard-sidebar/ui/SidebarFooterStrip
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import {
  Cable,
  Check,
  Copy,
  LayoutDashboard,
  RotateCw,
  Sparkles,
  Store,
  Users,
  X,
} from 'lucide-react';
import { useConfig, useUpdateConfig } from '@/layers/entities/config';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { useStartNewSession } from '@/layers/entities/session';
import { isHomeSurfacePath, TOUR_ANCHORS } from '@/layers/shared/config';
import { cn, isNewer, openLink, setAskDorkBotOrigin, TIMING } from '@/layers/shared/lib';
import { useIsMobile } from '@/layers/shared/model';
import { useDesktopUpdater } from '@/layers/features/session-list';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/layers/shared/ui';
import { FOOTER_LABELLED_ROW, SidebarFooterMenu } from './SidebarFooterMenu';

/** The command that updates a web/CLI install, offered by the pill. */
const UPDATE_COMMAND = 'npm update -g dorkos';

/** The system agent's fixed name on disk — how the roster is asked for DorkBot. */
const DORKBOT_AGENT_NAME = 'dorkbot';

/** One destination in the strip. */
interface Destination {
  /** Route to navigate to. */
  to: '/' | '/team' | '/marketplace' | '/connections';
  /** Accessible name; also the tooltip. */
  label: string;
  /** The glyph. */
  icon: React.ComponentType<{ className?: string }>;
  /** Whether this route (or a sub-route of it) is what is on screen. */
  isActive: (pathname: string) => boolean;
  /** Stable tour/e2e anchor stamped on the button (see TOUR_ANCHORS). */
  testId?: string;
}

/**
 * The four places, in the order the mockup draws them.
 *
 * Home reads active across all four of its routes because Activity, Scheduled
 * and Workspaces are tabs of the home surface: the sidebar answers "which part
 * of DorkOS", the tab bar answers "which part of Home".
 */
const DESTINATIONS: readonly Destination[] = [
  { to: '/', label: 'Home', icon: LayoutDashboard, isActive: isHomeSurfacePath },
  {
    to: '/team',
    label: 'Team',
    icon: Users,
    isActive: (pathname) => pathname === '/team',
    // Named `nav-agents` for the page's old title, and staying that way: it is
    // what the e2e specs click, and it moved here intact when the header nav it
    // used to live on was retired. A tour anchor that survives a component's
    // death only survives if something else stamps it.
    testId: TOUR_ANCHORS.navAgents,
  },
  {
    to: '/marketplace',
    label: 'Marketplace',
    icon: Store,
    isActive: (pathname) => pathname === '/marketplace' || pathname.startsWith('/marketplace/'),
  },
  {
    to: '/connections',
    label: 'Connections',
    icon: Cable,
    isActive: (pathname) => pathname === '/connections',
  },
];

/**
 * The footer strip: four destinations, the Ask DorkBot affordance, and an update
 * pill while one is waiting.
 */
export function SidebarFooterStrip() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useDevPlaygroundShortcut();
  // **One nav, two shapes.** A phone gives this the whole You tab instead of a
  // 272px footer, so the four places are named out loud, each is a thumb's
  // target, and the fold that exists only because a desktop panel was cramped
  // is named for what is behind it rather than for the fact that it is a fold.
  // A second implementation would be a second `nav-agents` anchor to keep
  // alive, and a second place for a fifth destination to be forgotten.
  const isMobile = useIsMobile();

  return (
    <div data-testid="sidebar-footer-strip">
      <UpdatePill />
      {/* One row. No `border-t`: the tint IS the separation, and the scroll-edge
          shadow on the body above is what says content continues under it. */}
      <div
        data-testid="sidebar-footer-strip-row"
        className={cn(
          'bg-sidebar-accent/60 rounded-lg',
          isMobile ? 'flex flex-col gap-0.5 p-1' : 'flex items-center gap-1 px-1.5 py-1'
        )}
      >
        {DESTINATIONS.map((destination) => (
          <DestinationButton
            key={destination.to}
            destination={destination}
            isActive={destination.isActive(pathname)}
            labelled={isMobile}
            onClick={() => navigate({ to: destination.to })}
          />
        ))}
        <div
          className={cn(
            'flex shrink-0',
            isMobile ? 'flex-col gap-0.5' : 'ml-auto items-center gap-0.5'
          )}
        >
          {/* Everything the strip has no room for, folded into one glyph — the
              account rows, the `sidebar.footer` slot, help and feedback. A real
              272px panel is what decided this, twice: as peers the footer
              contributions pushed the Ask DorkBot label onto a second line, and
              adding the operator's face alone took `scrollWidth` to 281 in a 256
              box. On a phone the fold stays — it is a genuinely long list — but
              it says what is inside it instead of being a "⋯" whose only name
              was a tooltip that touch screens do not have. */}
          <SidebarFooterMenu labelled={isMobile} />
          <AskDorkBotButton labelled={isMobile} />
        </div>
      </div>
    </div>
  );
}

/**
 * `⌘⇧D` opens the Dev Playground, in development builds only.
 *
 * It hangs off the footer because a global shortcut needs a component that is
 * mounted for the whole session and the strip is exactly that — the same reason
 * the footer bar this replaced owned it. `/dev` mounts outside the router, so
 * the seam classifies it as external and gives it its own window.
 */
function useDevPlaygroundShortcut(): void {
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        openLink('/dev');
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
}

/**
 * One destination glyph.
 *
 * @param props - The destination, whether it is the current route, and the click.
 */
function DestinationButton({
  destination,
  isActive,
  labelled,
  onClick,
}: {
  destination: Destination;
  isActive: boolean;
  /** Draw the name beside the glyph, in a thumb-sized row — the You tab. */
  labelled: boolean;
  onClick: () => void;
}) {
  const Icon = destination.icon;
  const button = (
    <button
      type="button"
      onClick={onClick}
      aria-label={destination.label}
      aria-current={isActive ? 'page' : undefined}
      data-sidebar-destination=""
      data-testid={destination.testId}
      className={cn(
        'focus-ring transition-colors duration-150',
        FOOTER_LABELLED_ROW,
        isActive
          ? 'text-sidebar-accent-foreground bg-sidebar/70 font-medium'
          : 'text-sidebar-foreground/80 hover:text-sidebar-foreground hover:bg-sidebar/50'
      )}
    >
      <Icon className="size-(--size-icon-sm) shrink-0" />
      {destination.label}
    </button>
  );
  // **No tooltip here, and that is the point.** A tooltip is the only name
  // these glyphs have on a pointer device, and it is no name at all on a touch
  // screen — there is nothing to hover. The label IS the name now.
  if (labelled) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={destination.label}
          aria-current={isActive ? 'page' : undefined}
          // Structural, and load-bearing for the browser spec that guards
          // "four places — nothing else". A locator that matched the four
          // NAMES could never see a fifth, because the fifth would be filtered
          // out before the count ran; this attribute is stamped by the loop, so
          // anything added to DESTINATIONS is counted whatever it is called.
          data-sidebar-destination=""
          data-testid={destination.testId}
          className={cn(
            // `focus-ring` explicitly: these are bare buttons, and the shadcn
            // `SidebarMenuButton` they replaced carried the ring for them. The
            // repo's ring is a utility, not a global `:focus-visible` rule, so
            // dropping it would have left the whole strip invisible to a
            // keyboard.
            'focus-ring rounded-md p-1 transition-colors duration-150',
            isActive
              ? 'text-sidebar-accent-foreground bg-sidebar/70'
              : 'text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar/50'
          )}
        >
          <Icon className="size-(--size-icon-sm)" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{destination.label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * ✦ Ask DorkBot — the permanent help affordance (BC-48), as a hook.
 *
 * It does not open docs. It opens a fresh conversation with DorkBot that already
 * knows where you were, how many agents you run and what is currently broken —
 * background the chat model composes and sends invisibly, so the composer you
 * land in is empty and focused, waiting for your own words.
 *
 * A hook rather than only a button, because a phone reaches the same act from a
 * bottom-bar destination instead of a 20px glyph (P4). One implementation, two
 * renderings — a second copy would be a second chance for the seed or the
 * origin to be forgotten.
 *
 * `ready` is `false` until the roster answers with DorkBot's directory: a
 * control that silently does nothing is worse than one that says it is not
 * ready yet.
 */
export function useAskDorkBot(): { ask: () => void; ready: boolean } {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const startNewSession = useStartNewSession();
  const { data: mesh } = useMeshAgentPaths();
  const dorkbotPath = (mesh?.agents ?? []).find(
    (agent) => agent.name === DORKBOT_AGENT_NAME
  )?.projectPath;

  const ask = useCallback(() => {
    if (dorkbotPath === undefined) return;
    // Recorded BEFORE the navigation, because after it the address bar says
    // `/session` and the page somebody came from is unrecoverable.
    setAskDorkBotOrigin(pathname);
    startNewSession(dorkbotPath, { seed: 'dorkbot-help' });
  }, [dorkbotPath, pathname, startNewSession]);

  return { ask, ready: dorkbotPath !== undefined };
}

/**
 * The strip's ✦ Ask DorkBot glyph — {@link useAskDorkBot}, wearing a button.
 *
 * @param props - Whether to draw it as a thumb-sized row (the You tab).
 */
function AskDorkBotButton({ labelled }: { labelled: boolean }) {
  const { ask, ready } = useAskDorkBot();

  return (
    <button
      type="button"
      onClick={ask}
      disabled={!ready}
      aria-label="Ask DorkBot"
      className={cn(
        'text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar/50 focus-ring font-medium whitespace-nowrap transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50',
        labelled
          ? FOOTER_LABELLED_ROW
          : 'inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11.5px]'
      )}
    >
      <Sparkles className={cn('shrink-0', labelled ? 'size-(--size-icon-sm)' : 'size-3')} />
      Ask DorkBot
    </button>
  );
}

/**
 * The transient update pill (BC-44).
 *
 * Present only while an update genuinely is ready, and absent — zero DOM — the
 * rest of the time. On the desktop app that means a downloaded update waiting
 * for a restart; on a web or CLI install it means a newer published version, and
 * the pill hands over the one command that installs it.
 */
function UpdatePill() {
  const { data: config } = useConfig();
  const { isDesktop, status: desktopStatus, restart } = useDesktopUpdater();
  const updateConfig = useUpdateConfig();
  const [copied, setCopied] = useState(false);

  const version = config?.version;
  const latestVersion = config?.latestVersion ?? null;
  const dismissed = useMemo(
    () => config?.dismissedUpgradeVersions ?? [],
    [config?.dismissedUpgradeVersions]
  );

  // The "Copied" beat clears itself, and clears its own timer on unmount: the
  // pill disappears the moment the dismissal lands, which is well inside the
  // feedback window, and a `setCopied` firing into an unmounted component is a
  // warning nobody can act on.
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    []
  );
  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(UPDATE_COMMAND);
    setCopied(true);
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), TIMING.COPY_FEEDBACK_MS);
  }, []);

  const handleDismiss = useCallback(
    (dismissVersion: string) => {
      // The mutation invalidates the config query itself, so the pill disappears
      // as soon as the server confirms — no second invalidation here.
      updateConfig.mutate({ ui: { dismissedUpgradeVersions: [...dismissed, dismissVersion] } });
    },
    [dismissed, updateConfig]
  );

  // Desktop reflects the native updater: `npm update -g dorkos` updates the CLI,
  // not the running `.app`. Only `downloaded` is ready — a download in progress
  // is not something anybody can act on, so it renders nothing.
  if (isDesktop) {
    if (desktopStatus?.state !== 'downloaded') return null;
    return (
      <div className="mb-1 flex items-center px-0.5">
        <button
          type="button"
          onClick={restart}
          aria-label="Restart to install the update"
          className="focus-ring inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 transition-colors duration-150 hover:bg-amber-500/25 dark:text-amber-300"
        >
          <RotateCw className="size-3" />
          Update ready — Restart
        </button>
      </div>
    );
  }

  const ready =
    latestVersion !== null &&
    version !== undefined &&
    isNewer(latestVersion, version) &&
    !dismissed.includes(latestVersion);
  if (!ready) return null;

  return (
    <div className="mb-1 flex items-center gap-1 px-0.5">
      <button
        type="button"
        onClick={handleCopy}
        aria-label={`Copy the command that updates DorkOS to v${latestVersion}`}
        className="focus-ring inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 transition-colors duration-150 hover:bg-amber-500/25 dark:text-amber-300"
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        {copied ? 'Command copied' : `Update ready — v${latestVersion}`}
      </button>
      <button
        type="button"
        onClick={() => handleDismiss(latestVersion)}
        aria-label="Dismiss update notification"
        className="text-sidebar-foreground/50 hover:text-sidebar-foreground focus-ring rounded-md p-0.5 transition-colors duration-150"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
