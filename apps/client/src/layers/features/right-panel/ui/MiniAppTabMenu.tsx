/**
 * The right panel's mini-app menu (spec `mini-app-placement`): open the active
 * mini app's full page, hide its tab here, change where it shows, and bring
 * back a mini-app tab that is hidden here.
 *
 * One button rather than three, because the header already holds the tab strip
 * and the close button, and a 375px panel has no room for more.
 *
 * @module features/right-panel/ui/MiniAppTabMenu
 */
import { Ellipsis, EyeOff, Maximize2, Plus, SlidersHorizontal } from 'lucide-react';
import {
  effectivePlacement,
  hideHere,
  mostSpecificTarget,
  showHere,
  type PlacementHere,
  type SavedPlacement,
} from '@dorkos/shared/mini-app-placement';
import { useSetPanelTabPlacement } from '@/layers/entities/config';
import { extensionPageHref } from '@/layers/shared/lib';
import {
  useAppStore,
  useMenuExtensionPages,
  useSafeNavigate,
  useSettingsDeepLink,
  useIsBelowDesktop,
  type RightPanelContribution,
} from '@/layers/shared/model';
import {
  Button,
  ContributedIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/layers/shared/ui';

/** Props for {@link MiniAppTabMenu}. */
export interface MiniAppTabMenuProps {
  /** The tab on screen, when it is a mini app's. */
  active: RightPanelContribution | null;
  /** Mini-app tabs that could show on this page but are hidden here. */
  hidden: readonly RightPanelContribution[];
  /** Where the person is. */
  here: PlacementHere;
  /** The saved choices, for the tabs this menu changes. */
  saved: ReadonlyMap<string, SavedPlacement>;
}

/**
 * The menu, or nothing when it would have nothing in it.
 *
 * @param props - See {@link MiniAppTabMenuProps}.
 */
export function MiniAppTabMenu({ active, hidden, here, saved }: MiniAppTabMenuProps) {
  const { setPlacement } = useSetPanelTabPlacement();
  const setActiveTab = useAppStore((s) => s.setActiveRightPanelTab);
  const settings = useSettingsDeepLink();
  const navigate = useSafeNavigate();
  const overlay = useIsBelowDesktop();
  const closePanel = useAppStore((s) => s.setRightPanelOpen);
  const pages = useMenuExtensionPages();

  // Where "here" is too broad to name (a chat with no agent, a room from a
  // connected community), hiding or showing here is not offered at all.
  const canPlaceHere = mostSpecificTarget(here) !== null;
  const placementOf = (tab: RightPanelContribution) =>
    effectivePlacement(saved.get(tab.id), tab.declaredPlacement);

  const fullPage =
    active?.extensionId != null
      ? (pages.find((p) => p.extensionId === active.extensionId && p.path === '') ??
        pages.find((p) => p.extensionId === active.extensionId) ??
        null)
      : null;
  const showable = canPlaceHere ? hidden : [];

  if (!active && showable.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-md"
          aria-label="Add-on tab options"
          className="size-11 shrink-0 lg:size-7"
          data-testid="mini-app-tab-menu"
        >
          <Ellipsis className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-[70dvh] min-w-48 overflow-y-auto [&_[role=menuitem]]:min-h-11 lg:[&_[role=menuitem]]:min-h-0"
      >
        {active && (
          <>
            {fullPage && navigate && (
              <DropdownMenuItem
                onSelect={() => {
                  if (overlay) closePanel(false);
                  void navigate({ href: extensionPageHref(fullPage.extensionId, fullPage.path) });
                }}
              >
                <Maximize2 />
                Open full page
              </DropdownMenuItem>
            )}
            {canPlaceHere && (
              <DropdownMenuItem
                onSelect={() => setPlacement(active.id, hideHere(placementOf(active), here))}
              >
                <EyeOff />
                Hide here
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => settings.open('extensions', active.extensionId)}>
              <SlidersHorizontal />
              Where it shows…
            </DropdownMenuItem>
          </>
        )}
        {active && showable.length > 0 && <DropdownMenuSeparator />}
        {showable.length > 0 && (
          <>
            <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
              Show here
            </DropdownMenuLabel>
            {showable.map((tab) => (
              <DropdownMenuItem
                key={tab.id}
                onSelect={() => {
                  setPlacement(tab.id, showHere(placementOf(tab), here));
                  setActiveTab(tab.id);
                }}
              >
                {tab.icon ? <ContributedIcon icon={tab.icon} /> : <Plus />}
                {tab.title}
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
