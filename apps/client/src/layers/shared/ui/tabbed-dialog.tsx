import { Suspense, type ComponentType, type ReactNode } from 'react';
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
  NavigationLayoutItem,
  NavigationLayoutContent,
  NavigationLayoutPanel,
  NavigationLayoutPanelHeader,
} from '@/layers/shared/ui';
import { useSlotContributions, type SlotId } from '@/layers/shared/model';
import { useDialogTabState } from '@/layers/shared/model/use-dialog-tab-state';
import { cn } from '@/layers/shared/lib';

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
  /** data-testid for browser tests. */
  testId?: string;
}

/**
 * Tabbed dialog primitive — responsive sidebar navigation over a `ResponsiveDialog`,
 * with mobile drill-in, animated active-tab pill, extension-slot support, and
 * deep-link sync via `useDialogTabState`.
 *
 * Used by SettingsDialog and AgentDialog. Built on top of `NavigationLayout`.
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
  testId,
}: TabbedDialogProps<T>) {
  const [activeTab, setActiveTab] = useDialogTabState<T>({
    open,
    initialTab: initialTab ?? null,
    defaultTab,
  });
  const extensionTabs = useSlotContributions(extensionSlot ?? 'settings.tabs');
  const allTabs = extensionSlot ? [...tabs, ...extensionTabs.map(toTabbedDialogTab<T>)] : tabs;

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        data-testid={testId}
        className={cn('max-h-[85vh] gap-0 p-0', maxWidth)}
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
              {allTabs.map((tab) => (
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
                    <div className="space-y-4">
                      <NavigationLayoutPanelHeader actions={tab.actions}>
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

/** Convert a `SettingsTabContribution` from the registry into a `TabbedDialogTab`. */
function toTabbedDialogTab<T extends string>(contribution: {
  id: string;
  label: string;
  icon: LucideIcon;
  component: ComponentType;
}): TabbedDialogTab<T> {
  return {
    id: contribution.id as T,
    label: contribution.label,
    icon: contribution.icon,
    component: contribution.component,
  };
}
