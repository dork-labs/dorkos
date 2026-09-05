import { Fragment, Suspense, useEffect, type ComponentType, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFullscreenToggle,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  NavigationLayout,
  NavigationLayoutDialogHeader,
  NavigationLayoutBody,
  NavigationLayoutSidebar,
  NavigationLayoutSectionHeader,
  NavigationLayoutItem,
  NavigationLayoutContent,
  NavigationLayoutPanel,
  NavigationLayoutPanelHeader,
} from '@/layers/shared/ui';
import { useSlotContributions, type SlotId } from '@/layers/shared/model';
import { useDialogTabState } from '@/layers/shared/model/use-dialog-tab-state';
import { cn } from '@/layers/shared/lib/utils';

/** A single tab definition for `TabbedDialog`. */
export interface TabbedDialogTab<T extends string> {
  /** Stable tab ID — used for active-tab matching and deep-link target. */
  id: T;
  /** Sidebar label. */
  label: string;
  /** Sidebar icon. */
  icon: LucideIcon;
  /** Panel content component (parameterless — reads its own state via context/store/queries). */
  component: ComponentType;
  /** Optional per-tab header actions (e.g., a "Reset to defaults" button). */
  actions?: ReactNode;
  /** Optional description rendered below the panel header title on desktop. */
  description?: ReactNode;
  /**
   * Optional sidebar group this tab sits under. Tabs sharing a group render
   * beneath one section header; tabs with no group render ungrouped at the top,
   * above the first header. Group order follows first appearance in the tab
   * list, so the ungrouped tabs always lead. When no tab declares a group the
   * sidebar stays flat and no headers render.
   */
  group?: string;
}

/** Props for `TabbedDialog`. */
export interface TabbedDialogProps<T extends string> {
  /** Whether the dialog is open. */
  open: boolean;
  /** Callback to change the open state. */
  onOpenChange: (open: boolean) => void;
  /** Title in the dialog header. ReactNode so it can include badges, breadcrumbs, etc. */
  title: ReactNode;
  /** Optional dialog description. Defaults to `sr-only`. */
  description?: string;
  /** Optional visible header content rendered below the title (e.g., breadcrumb). */
  headerSlot?: ReactNode;
  /** Default active tab when no `initialTab` is set. */
  defaultTab: T;
  /** Pre-navigate to this tab when the dialog opens. Honored on each open. */
  initialTab?: T | null;
  /** Built-in tabs. */
  tabs: TabbedDialogTab<T>[];
  /** Optional non-tab sidebar items (e.g., a button that opens a sub-dialog). */
  sidebarExtras?: ReactNode;
  /**
   * Optional extension slot ID. When set, contributions from the registry are merged
   * into the tab list (built-ins first, extensions appended).
   */
  extensionSlot?: Extract<SlotId, 'settings.tabs'>;
  /** Override max-width. Defaults to `max-w-2xl`. */
  maxWidth?: string;
  /** Override min content height. Defaults to `min-h-[280px]`. */
  minHeight?: string;
  /**
   * Open at near-viewport size instead of sizing to the content.
   *
   * For a dialog that is a workspace rather than a question — many tabs, long
   * panels, settings you scroll through — where a content-height box means
   * scrolling a small window inside a large empty screen. The sidebar and the
   * panel stretch to the new height, and the panel is what scrolls.
   *
   * Desktop only: every class this adds is behind `md`, which lines up with
   * the 768px boundary `useIsMobile` uses to swap the dialog for a drawer
   * (exactly, under the default 16px root font — `md` is 48rem, the hook is
   * hard pixels), so the phone layout is untouched.
   */
  maximized?: boolean;
  /** data-testid for browser tests. */
  testId?: string;
}

/**
 * Tabbed dialog primitive — responsive sidebar navigation over a `ResponsiveDialog`,
 * with mobile drill-in, animated active-tab pill, extension-slot support, and
 * deep-link sync via `useDialogTabState`.
 *
 * Used by `SettingsDialog`. Built on top of `NavigationLayout`.
 *
 * Keyboard navigation is provided by `NavigationLayout`'s built-in `role="tablist"`
 * with arrow keys (Up/Down/Home/End) when a sidebar item is focused.
 */
export function TabbedDialog<T extends string>({
  open,
  onOpenChange,
  title,
  description,
  headerSlot,
  defaultTab,
  initialTab,
  tabs,
  sidebarExtras,
  extensionSlot,
  maxWidth = 'max-w-2xl',
  minHeight = 'min-h-[280px]',
  maximized = false,
  testId,
}: TabbedDialogProps<T>) {
  const extensionTabs = useSlotContributions(extensionSlot ?? 'settings.tabs');
  const allTabs = extensionSlot ? [...tabs, ...extensionTabs.map(toTabbedDialogTab<T>)] : tabs;

  // Group the tabs for the sidebar. Order follows first appearance so the
  // ungrouped tabs (declared first) always lead; every later group renders once,
  // in the order its first member appears. When no tab has a group the list is
  // one ungrouped run and no headers show — flat, as before.
  const groupOrder: (string | undefined)[] = [];
  for (const tab of allTabs) {
    if (!groupOrder.includes(tab.group)) groupOrder.push(tab.group);
  }
  const hasGroups = allTabs.some((tab) => tab.group);

  // A deep link can name a tab that does not exist — a stale bookmark, a
  // renamed tab, a typo in `?settings=`, or a tour pointing at a tab that was
  // removed (tour deep links are unconstrained `string`). Selecting it would
  // render a sidebar with nothing active and an empty panel: a dialog that
  // looks broken and gives no clue why. Falling back to `defaultTab` is the
  // honest failure — the user lands somewhere real. Resolved against `allTabs`
  // so extension-contributed tabs count as valid.
  const targetTab = initialTab && allTabs.some((t) => t.id === initialTab) ? initialTab : null;

  // The fallback above is silent by design (no toast, no error UI — see the
  // comment there), but silent should not mean invisible everywhere. A
  // genuinely unknown id is still worth a signal a developer can see while
  // reproducing a stale-link report, so it goes to the console in dev only.
  useEffect(() => {
    if (import.meta.env.DEV && initialTab && !targetTab) {
      console.warn(
        `[TabbedDialog] Unknown deep-link tab id "${initialTab}" — falling back to "${defaultTab}". ` +
          'Likely a stale bookmark, a typo in a shared link, a tab that was renamed or removed, ' +
          'or an extension tab that has not finished loading.'
      );
    }
  }, [initialTab, targetTab, defaultTab]);

  const [activeTab, setActiveTab] = useDialogTabState<T>({
    open,
    initialTab: targetTab,
    defaultTab,
  });

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        data-testid={testId}
        className={cn(
          'max-h-[85vh] gap-0 p-0',
          maxWidth,
          // `md` (48rem) matches the hard 768px boundary `useIsMobile` uses to
          // swap the dialog for a drawer — equal under the default 16px root
          // font — so these classes never reach a drawer. `max-h` has to be
          // restated or the 85vh cap above would keep winning and the height
          // would be a lie.
          maximized && 'md:h-[92svh] md:max-h-[92svh] md:w-[95vw] md:max-w-[90rem]'
        )}
      >
        <NavigationLayout value={activeTab} onValueChange={(v) => setActiveTab(v as T)}>
          <ResponsiveDialogFullscreenToggle />
          <NavigationLayoutDialogHeader>
            <ResponsiveDialogTitle className="text-sm font-medium">{title}</ResponsiveDialogTitle>
            <ResponsiveDialogDescription
              className={description ? 'text-muted-foreground text-xs' : 'sr-only'}
            >
              {description ?? 'Dialog'}
            </ResponsiveDialogDescription>
            {headerSlot}
          </NavigationLayoutDialogHeader>

          <NavigationLayoutBody>
            <NavigationLayoutSidebar>
              {hasGroups
                ? groupOrder.map((group) => (
                    <Fragment key={group ?? '__ungrouped'}>
                      {group && (
                        <NavigationLayoutSectionHeader>{group}</NavigationLayoutSectionHeader>
                      )}
                      {allTabs
                        .filter((tab) => tab.group === group)
                        .map((tab) => (
                          <NavigationLayoutItem key={tab.id} value={tab.id} icon={tab.icon}>
                            {tab.label}
                          </NavigationLayoutItem>
                        ))}
                    </Fragment>
                  ))
                : allTabs.map((tab) => (
                    <NavigationLayoutItem key={tab.id} value={tab.id} icon={tab.icon}>
                      {tab.label}
                    </NavigationLayoutItem>
                  ))}
              {sidebarExtras}
            </NavigationLayoutSidebar>

            <NavigationLayoutContent className={cn(minHeight, 'p-4')}>
              {allTabs.map((tab) => {
                const TabComponent = tab.component;
                return (
                  <NavigationLayoutPanel key={tab.id} value={tab.id}>
                    {/* A readable measure inside any width: at the default
                        max-w-2xl the panel never reaches 48rem so this is
                        inert, and in a maximized dialog it stops body text
                        running 150+ characters per line. */}
                    <div className="max-w-3xl space-y-4">
                      <NavigationLayoutPanelHeader
                        actions={tab.actions}
                        description={tab.description}
                      >
                        {tab.label}
                      </NavigationLayoutPanelHeader>
                      <Suspense fallback={<TabSuspenseFallback />}>
                        <TabComponent />
                      </Suspense>
                    </div>
                  </NavigationLayoutPanel>
                );
              })}
            </NavigationLayoutContent>
          </NavigationLayoutBody>
        </NavigationLayout>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function TabSuspenseFallback() {
  return <div className="text-muted-foreground py-8 text-center text-sm">Loading…</div>;
}

/**
 * Convert a `SettingsTabContribution` from the registry into a `TabbedDialogTab`.
 *
 * A contribution with no `group` lands under "Add-ons" — the home the settings
 * dialog reserves for extension-contributed tabs — so a third-party tab written
 * before this field existed still files itself somewhere honest rather than
 * floating ungrouped above the first section header.
 */
function toTabbedDialogTab<T extends string>(contribution: {
  id: string;
  label: string;
  icon: LucideIcon;
  component: ComponentType;
  group?: string;
}): TabbedDialogTab<T> {
  return {
    id: contribution.id as T,
    label: contribution.label,
    icon: contribution.icon,
    component: contribution.component,
    group: contribution.group ?? 'Add-ons',
  };
}
