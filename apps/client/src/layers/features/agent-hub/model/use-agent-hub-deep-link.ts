/**
 * Agent Hub deep-link hooks — bridges URL search params to Agent Hub state.
 *
 * Provides two hooks:
 * - `useAgentHubDeepLink`: reads `?panel=agent-hub&hubTab=...&agentPath=...`
 *   and syncs the hub store on mount/change.
 * - `useAgentDialogRedirect`: detects legacy `?agent=<tab>&agentPath=<path>`
 *   params and replaces them with the new `?panel=agent-hub&hubTab=...` format.
 *
 * Tab migration map (old agent dialog → new hub tab):
 *   identity    → sessions
 *   personality → config
 *   channels    → config
 *   tools       → config
 *
 * @module features/agent-hub/model/use-agent-hub-deep-link
 */
import { useEffect } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useAgentHubStore, type AgentHubTab } from './agent-hub-store';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** URL param value that signals "open the Agent Hub panel". */
const AGENT_HUB_PANEL_ID = 'agent-hub';

/** Valid hub tab IDs — used to validate and sanitise the `hubTab` param. */
const VALID_HUB_TABS = new Set<AgentHubTab>(['sessions', 'config']);

/** Maps old tab names to their new 2-tab equivalents. */
const TAB_MIGRATION: Record<string, AgentHubTab> = {
  overview: 'sessions',
  profile: 'sessions',
  personality: 'config',
  sessions: 'sessions',
  channels: 'config',
  tasks: 'sessions',
  tools: 'config',
};

/** Maps old agent-dialog tab names to their new hub tab equivalents. */
const LEGACY_TAB_MAP: Record<string, AgentHubTab> = {
  identity: 'sessions',
  personality: 'config',
  channels: 'config',
  tools: 'config',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Route-agnostic search updater — matches the pattern in use-dialog-deep-link.ts. */
type AnySearchUpdater = (
  prev: Record<string, string | undefined>
) => Record<string, string | undefined>;

/**
 * Resolve a raw `hubTab` URL param to a valid `AgentHubTab`.
 *
 * Checks the new 3-tab set first. Falls back to the migration map for old
 * 6-tab names, then defaults to `'profile'` for unknown values.
 */
function resolveHubTab(raw: string | undefined): AgentHubTab {
  if (!raw) return 'sessions';
  if (VALID_HUB_TABS.has(raw as AgentHubTab)) {
    return raw as AgentHubTab;
  }
  return TAB_MIGRATION[raw] ?? 'sessions';
}

// ---------------------------------------------------------------------------
// useAgentHubDeepLink
// ---------------------------------------------------------------------------

/**
 * Reads the new-format deep-link params (`?panel=agent-hub&hubTab=...&agentPath=...`)
 * and syncs them into the Agent Hub store on every navigation.
 *
 * Call this once near the top of the component tree where the hub panel lives.
 * It has no return value — the side-effect is store synchronisation.
 */
export function useAgentHubDeepLink(): void {
  const search = useSearch({ strict: false }) as {
    panel?: string;
    hubTab?: string;
    agentPath?: string;
  };

  const openHub = useAgentHubStore((s) => s.openHub);

  const isHubPanel = search.panel === AGENT_HUB_PANEL_ID;
  const hubTab = resolveHubTab(search.hubTab);
  const agentPath = search.agentPath ?? null;

  useEffect(() => {
    if (!isHubPanel) return;

    if (agentPath) {
      // Full deep-link: open hub at a specific agent + tab.
      openHub(agentPath, hubTab);
    } else {
      // Panel param present but no agentPath — just switch to the requested tab.
      useAgentHubStore.getState().setActiveTab(hubTab);
    }
  }, [isHubPanel, hubTab, agentPath, openHub]);
}

// ---------------------------------------------------------------------------
// useAgentDialogRedirect
// ---------------------------------------------------------------------------

/**
 * Redirect guard for legacy agent-dialog URL params.
 *
 * Detects `?agent=<oldTab>&agentPath=<path>` (or `?dialog=agent`) in the URL
 * and replaces the search params with the new `?panel=agent-hub&hubTab=...`
 * format using `replace: true` so the old URL doesn't pollute browser history.
 *
 * Call this once at the application root or wherever the old deep-links were
 * previously handled.
 */
export function useAgentDialogRedirect(): void {
  const search = useSearch({ strict: false }) as {
    agent?: string;
    agentPath?: string;
    dialog?: string;
  };
  const navigate = useNavigate();

  const hasLegacyAgent = !!search.agent;
  const hasLegacyDialog = search.dialog === 'agent';
  const needsRedirect = hasLegacyAgent || hasLegacyDialog;

  useEffect(() => {
    if (!needsRedirect) return;

    // Map the old tab param to the new hub tab (fall back to 'sessions').
    const newHubTab: AgentHubTab =
      (search.agent ? LEGACY_TAB_MAP[search.agent] : undefined) ?? 'sessions';

    const updater: AnySearchUpdater = (prev) => {
      const next = { ...prev };

      // Remove legacy params.
      delete next.agent;
      delete next.dialog;

      // Write new params.
      next.panel = AGENT_HUB_PANEL_ID;
      next.hubTab = newHubTab;

      // Preserve agentPath if it was already set.
      if (prev.agentPath) {
        next.agentPath = prev.agentPath;
      }

      return next;
    };

    navigate({ search: updater as never, replace: true });
  }, [needsRedirect, search.agent, search.agentPath, search.dialog, navigate]);
}
