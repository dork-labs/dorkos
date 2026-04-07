/**
 * Dialog deep-link hooks — bridges global dialog open/tab state to TanStack Router search params.
 *
 * Each hook reads its dialog's URL signal (`?settings=tools`, `?agent=identity&agentPath=...`,
 * `?tasks=open`, etc.) and exposes typed open/close/setTab actions that mirror back to the URL.
 * Used by `RegistryDialog` (open state) and the dialog components themselves (active tab).
 *
 * @module shared/model/use-dialog-deep-link
 */
import { useCallback } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { SettingsTab, AgentDialogTab } from './app-store/app-store-panels';

// Route-agnostic search updater type used internally. We cast to this when
// calling navigate without a `to:` — these hooks are intentionally generic
// across routes so TanStack Router can't infer the route-specific search type
// at compile time. Mirrors the pattern in `use-filter-state.ts`.
type AnySearchUpdater = (
  prev: Record<string, string | undefined>
) => Record<string, string | undefined>;

/** Generic shape returned by every dialog deep-link hook. */
export interface DialogDeepLink<T extends string> {
  /** True if the dialog should be open per the URL. */
  isOpen: boolean;
  /** Active tab from the URL (or null if the param is `'open'` / not set). */
  activeTab: T | null;
  /** Sub-section anchor (for intra-tab scroll/expand). */
  section: string | null;
  /** Open the dialog. Pass a tab to deep-link to a specific tab. */
  open: (tab?: T, section?: string) => void;
  /** Close the dialog. Clears all related search params. */
  close: () => void;
  /** Switch active tab without closing. Replaces history entry. */
  setTab: (tab: T) => void;
  /** Set or clear the sub-section anchor. Replaces history entry. */
  setSection: (section: string | null) => void;
}

/** Settings dialog deep-link state and actions. */
export function useSettingsDeepLink(): DialogDeepLink<SettingsTab> {
  const search = useSearch({ strict: false }) as { settings?: string; settingsSection?: string };
  const navigate = useNavigate();

  const isOpen = !!search.settings;
  const activeTab = isOpen && search.settings !== 'open' ? (search.settings as SettingsTab) : null;
  const section = search.settingsSection ?? null;

  const open = useCallback(
    (tab?: SettingsTab, sectionId?: string) => {
      const updater: AnySearchUpdater = (prev) => ({
        ...prev,
        settings: tab ?? 'open',
        settingsSection: sectionId,
      });
      navigate({ search: updater as never });
    },
    [navigate]
  );

  const close = useCallback(() => {
    const updater: AnySearchUpdater = (prev) => ({
      ...prev,
      settings: undefined,
      settingsSection: undefined,
    });
    navigate({ search: updater as never });
  }, [navigate]);

  const setTab = useCallback(
    (tab: SettingsTab) => {
      const updater: AnySearchUpdater = (prev) => ({
        ...prev,
        settings: tab,
        settingsSection: undefined,
      });
      navigate({ search: updater as never, replace: true });
    },
    [navigate]
  );

  const setSection = useCallback(
    (sectionId: string | null) => {
      const updater: AnySearchUpdater = (prev) => ({
        ...prev,
        settingsSection: sectionId ?? undefined,
      });
      navigate({ search: updater as never, replace: true });
    },
    [navigate]
  );

  return { isOpen, activeTab, section, open, close, setTab, setSection };
}

/** Agent dialog deep-link state and actions. Includes `agentPath` accessor. */
export function useAgentDialogDeepLink(): DialogDeepLink<AgentDialogTab> & {
  agentPath: string | null;
} {
  const search = useSearch({ strict: false }) as { agent?: string; agentPath?: string };
  const navigate = useNavigate();

  const isOpen = !!search.agent && !!search.agentPath;
  const activeTab = isOpen && search.agent !== 'open' ? (search.agent as AgentDialogTab) : null;
  const agentPath = search.agentPath ?? null;

  const open = useCallback(
    (tab?: AgentDialogTab) => {
      // open requires the agentPath be set already; callers use `useOpenAgentDialog` below
      const updater: AnySearchUpdater = (prev) => ({ ...prev, agent: tab ?? 'open' });
      navigate({ search: updater as never });
    },
    [navigate]
  );

  const close = useCallback(() => {
    const updater: AnySearchUpdater = (prev) => ({
      ...prev,
      agent: undefined,
      agentPath: undefined,
    });
    navigate({ search: updater as never });
  }, [navigate]);

  const setTab = useCallback(
    (tab: AgentDialogTab) => {
      const updater: AnySearchUpdater = (prev) => ({ ...prev, agent: tab });
      navigate({ search: updater as never, replace: true });
    },
    [navigate]
  );

  return {
    isOpen,
    activeTab,
    section: null,
    agentPath,
    open,
    close,
    setTab,
    setSection: () => {},
  };
}

/** Convenience: open the agent dialog for a specific project path. */
export function useOpenAgentDialog() {
  const navigate = useNavigate();
  return useCallback(
    (agentPath: string, tab?: AgentDialogTab) => {
      const updater: AnySearchUpdater = (prev) => ({
        ...prev,
        agent: tab ?? 'open',
        agentPath,
      });
      navigate({ search: updater as never });
    },
    [navigate]
  );
}

/** Tasks dialog deep-link state and actions. No tabs. */
export function useTasksDeepLink(): DialogDeepLink<never> {
  return useSimpleDialogDeepLink('tasks');
}

/** Relay dialog deep-link state and actions. No tabs. */
export function useRelayDeepLink(): DialogDeepLink<never> {
  return useSimpleDialogDeepLink('relay');
}

/** Mesh dialog deep-link state and actions. No tabs. */
export function useMeshDeepLink(): DialogDeepLink<never> {
  return useSimpleDialogDeepLink('mesh');
}

/** Internal helper for parameterless (no-tab) dialogs. */
function useSimpleDialogDeepLink(paramName: 'tasks' | 'relay' | 'mesh'): DialogDeepLink<never> {
  const search = useSearch({ strict: false }) as Record<string, string | undefined>;
  const navigate = useNavigate();
  const isOpen = !!search[paramName];

  const open = useCallback(() => {
    const updater: AnySearchUpdater = (prev) => ({ ...prev, [paramName]: 'open' });
    navigate({ search: updater as never });
  }, [navigate, paramName]);

  const close = useCallback(() => {
    const updater: AnySearchUpdater = (prev) => ({ ...prev, [paramName]: undefined });
    navigate({ search: updater as never });
  }, [navigate, paramName]);

  return {
    isOpen,
    activeTab: null,
    section: null,
    open,
    close,
    setTab: () => {},
    setSection: () => {},
  };
}
