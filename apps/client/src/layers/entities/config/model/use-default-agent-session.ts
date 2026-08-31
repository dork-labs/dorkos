import { useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { ServerConfig } from '@dorkos/shared/types';
import { useTransport } from '@/layers/shared/model';
import { useConfig } from './use-config';

/** Fallback agent slug when config has no configured default (a fresh install). */
const DEFAULT_AGENT = 'dorkbot';

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
 * A last-resort FALLBACK for an agent that is not in the mesh registry yet —
 * prefer the REGISTERED absolute path from {@link useDefaultAgentSession}.
 *
 * Returns `''` until the config arrives, rather than guessing a path. The
 * directory the server reports is the absolute one it resolves agent creation
 * against, and there is no way to compute that from the client; a guess would
 * name a folder that may not exist and cannot be streamed.
 *
 * @param config - The server config, or `undefined` while it loads.
 */
export function resolveDefaultAgentDir(config: ServerConfig | undefined): string {
  const dir = config?.agents?.defaultDirectory;
  if (!dir) return '';
  const agent = config?.agents?.defaultAgent || DEFAULT_AGENT;
  return `${dir}/${agent}`;
}

/** What {@link useDefaultAgentSession} returns. */
export interface DefaultAgentSession {
  /** Open a chat session with the configured default agent (DorkBot by default). */
  startSession: () => void;
  /** The default agent's working directory — a real absolute path when registered. */
  defaultAgentDir: string;
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

  const startSession = useCallback(() => {
    navigate({ to: '/session', search: { dir: defaultAgentDir } });
  }, [navigate, defaultAgentDir]);

  return {
    startSession,
    defaultAgentDir,
  };
}
