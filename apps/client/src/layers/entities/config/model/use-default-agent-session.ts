import { useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import type { ServerConfig } from '@dorkos/shared/types';
import { getAgentDisplayName } from '@dorkos/shared/validation';
import { useTransport } from '@/layers/shared/model';
import { useConfig } from './use-config';

/** Fallback agent slug when config has no configured default (a fresh install). */
const DEFAULT_AGENT = 'dorkbot';
/** Fallback agents directory matching the server-side default. */
const DEFAULT_AGENTS_DIR = '~/.dork/agents';
/** Runtime assumed for a default agent whose entry carries no runtime. */
const DEFAULT_RUNTIME = 'claude-code';

/**
 * Query key for the mesh agent-path registry. Kept in sync with `entities/mesh`'s
 * `useMeshAgentPaths` so both share one cache entry — read here via the transport
 * seam rather than a sibling-entity import (FSD forbids entities importing
 * entities).
 */
const MESH_AGENT_PATHS_KEY = ['mesh', 'agent-paths'] as const;

/**
 * Compose the default agent's working directory from config strings alone.
 *
 * This is only a last-resort FALLBACK: `config.agents.defaultDirectory` is stored
 * literally (an unexpanded `~/.dork/agents`), so a session opened at this path
 * cannot be streamed — the events stream 403s on the unresolved tilde. Prefer the
 * REGISTERED absolute path from {@link useDefaultAgentSession}; this is used only
 * when the agent is not yet in the registry.
 *
 * @param config - The server config, or `undefined` while it loads.
 */
export function resolveDefaultAgentDir(config: ServerConfig | undefined): string {
  const agent = config?.agents?.defaultAgent || DEFAULT_AGENT;
  const dir = config?.agents?.defaultDirectory || DEFAULT_AGENTS_DIR;
  return `${dir}/${agent}`;
}

/**
 * The default agent's identity, enough to build an agent-birth record for the
 * `first-message` seam (ADR 260722-111316) — the dashboard composer opens a
 * session pre-loaded with the user's typed words the same way onboarding's
 * dissolve does.
 */
export interface DefaultAgentIdentity {
  /** Kebab-case agent slug. */
  name: string;
  /** Human display name (the roster's single source of truth). */
  displayName: string;
  /** The agent's ULID — the seed for its deterministic visual identity. */
  agentId: string;
  /** Emoji face override, when the agent has one. */
  icon?: string;
  /** Color override, when the agent has one. */
  color?: string;
  /** The runtime the agent runs on. */
  runtime: string;
}

/** What {@link useDefaultAgentSession} returns. */
export interface DefaultAgentSession {
  /** Open a chat session with the configured default agent (DorkBot by default). */
  startSession: () => void;
  /** The default agent's working directory — a real absolute path when registered. */
  defaultAgentDir: string;
  /** The default agent's human display name, for composer placeholders. */
  defaultAgentDisplayName: string;
  /** The default agent's identity for building a `first-message` birth record. */
  defaultAgentIdentity: DefaultAgentIdentity;
  /**
   * Whether {@link defaultAgentDir} is the agent's REGISTRY-resolved absolute
   * path (not the config-string fallback). Only a registry-resolved path can be
   * streamed — starting a session with a message must wait for this to be `true`,
   * or the events stream 403s on the unresolved tilde.
   */
  isDefaultAgentResolved: boolean;
}

/**
 * Resolve the default agent's identity from its registered mesh entry, falling
 * back to config strings when the agent is not yet in the registry.
 *
 * @param entry - The registered agent-path entry, or `undefined`.
 * @param fallbackName - The configured default agent slug.
 */
function resolveDefaultAgentIdentity(
  entry: AgentPathEntry | undefined,
  fallbackName: string
): DefaultAgentIdentity {
  if (!entry) {
    return {
      name: fallbackName,
      displayName: getAgentDisplayName({ name: fallbackName }),
      agentId: fallbackName,
      runtime: DEFAULT_RUNTIME,
    };
  }
  return {
    name: entry.name,
    displayName: getAgentDisplayName(entry),
    agentId: entry.id,
    icon: entry.icon,
    color: entry.color,
    runtime: DEFAULT_RUNTIME,
  };
}

/**
 * Start a conversation with the configured default agent. On a fresh install
 * this is DorkBot; a user who changes their default agent gets that one instead.
 * Backs the dashboard composer (start a session pre-loaded with a message), the
 * sidebar getting-started card's "Talk to DorkBot" row, and onboarding's dissolve
 * into a live session.
 *
 * The directory is the agent's REGISTERED absolute path from the mesh registry —
 * the only path the client can actually stream (the sidebar opens sessions with
 * exactly these). The config-string compose ({@link resolveDefaultAgentDir}) is a
 * last-resort fallback for an agent not yet registered.
 */
export function useDefaultAgentSession(): DefaultAgentSession {
  const navigate = useNavigate();
  const transport = useTransport();
  const { data: config } = useConfig();

  const { data: agentPaths } = useQuery({
    queryKey: [...MESH_AGENT_PATHS_KEY],
    queryFn: () => transport.listMeshAgentPaths(),
    staleTime: 30_000,
  });

  const defaultAgentName = config?.agents?.defaultAgent || DEFAULT_AGENT;
  const registeredEntry = agentPaths?.agents.find((a) => a.name === defaultAgentName);
  const defaultAgentDir = registeredEntry?.projectPath ?? resolveDefaultAgentDir(config);
  const defaultAgentIdentity = resolveDefaultAgentIdentity(registeredEntry, defaultAgentName);

  const startSession = useCallback(() => {
    navigate({ to: '/session', search: { dir: defaultAgentDir } });
  }, [navigate, defaultAgentDir]);

  return {
    startSession,
    defaultAgentDir,
    defaultAgentDisplayName: defaultAgentIdentity.displayName,
    defaultAgentIdentity,
    isDefaultAgentResolved: registeredEntry !== undefined,
  };
}
