import { useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { ServerConfig } from '@dorkos/shared/types';
import { useConfig } from './use-config';

/** Fallback agent slug when config has no configured default (a fresh install). */
const DEFAULT_AGENT = 'dorkbot';
/** Fallback agents directory matching the server-side default. */
const DEFAULT_AGENTS_DIR = '~/.dork/agents';

/**
 * Resolve the working directory of the configured default agent — the single
 * place this path is derived. Shared by onboarding's finish CTA and the
 * post-onboarding conversation entry points so they always open the same agent.
 *
 * @param config - The server config, or `undefined` while it loads.
 */
export function resolveDefaultAgentDir(config: ServerConfig | undefined): string {
  const agent = config?.agents?.defaultAgent || DEFAULT_AGENT;
  const dir = config?.agents?.defaultDirectory || DEFAULT_AGENTS_DIR;
  return `${dir}/${agent}`;
}

/** What {@link useDefaultAgentSession} returns. */
export interface DefaultAgentSession {
  /** Open a chat session with the configured default agent (DorkBot by default). */
  startSession: () => void;
  /** The resolved working directory of the default agent. */
  defaultAgentDir: string;
}

/**
 * Start a conversation with the configured default agent. On a fresh install
 * this is DorkBot; a user who changes their default agent gets that one
 * instead. Backs the dashboard's "New conversation" button and the sidebar
 * getting-started card's "Talk to DorkBot" row.
 */
export function useDefaultAgentSession(): DefaultAgentSession {
  const navigate = useNavigate();
  const { data: config } = useConfig();
  const defaultAgentDir = resolveDefaultAgentDir(config);

  const startSession = useCallback(() => {
    navigate({ to: '/session', search: { dir: defaultAgentDir } });
  }, [navigate, defaultAgentDir]);

  return { startSession, defaultAgentDir };
}
