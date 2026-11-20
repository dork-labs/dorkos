import type { JSHandle, Page } from 'playwright-core';
import type {
  LocalBrowserAction,
  LocalBrowserObservation,
  LocalBrowserState,
} from '@dorkos/shared/local-browser';
import type { ObservedPageNodes } from '../observation-nodes.js';
import type { BrowserActionFlight } from '../lifecycle.js';
import { actionFence, auditPageAction, performPageAction } from '../page-action.js';
import type { LocalBrowserAuditWriter } from '../action-audit.js';
import type { BrowserPageState } from './page-state.js';
import { LocalBrowserError } from '../errors.js';

/** Page-local effect admission; profile and caller identity have already been captured. */
export interface LeaseActionHost {
  page(): Page;
  assertAvailable(): void;
  assertDestination(url: string): void;
  refuse(page: Page): void;
  stale(): LocalBrowserError;
  admit(revision: number): void;
  invalidate(): void;
  state(): Promise<LocalBrowserState>;
  revision: number;
  observation?: LocalBrowserObservation;
  nodes?: JSHandle<ObservedPageNodes>;
  actions: BrowserActionFlight;
}

interface AgentActionHost extends Pick<
  LeaseActionHost,
  | 'page'
  | 'assertAvailable'
  | 'assertDestination'
  | 'refuse'
  | 'stale'
  | 'admit'
  | 'invalidate'
  | 'state'
  | 'actions'
> {
  pageState: BrowserPageState;
  audit(): LocalBrowserAuditWriter;
  identity(): Parameters<typeof auditPageAction>[1];
  lifecycle(): number;
}

/** Audit and effect admission retain one Page's physical action flight. */
export class BrowserAgentPageActions {
  constructor(private readonly host: AgentActionHost) {}

  action(input: LocalBrowserAction): Promise<LocalBrowserState> {
    const h = this.host;
    return auditPageAction(
      h.pageState.tabs.get(h.pageState.selectedTabId ?? ''),
      h.identity(),
      input,
      h.audit(),
      (dispatch) => {
        const lifecycle = h.lifecycle();
        return performLeaseAction(
          {
            ...h,
            revision: h.pageState.revision,
            observation: h.pageState.observation,
            nodes: h.pageState.observedNodes,
            invalidate: () => {
              if (h.lifecycle() === lifecycle) h.invalidate();
            },
          },
          input,
          dispatch
        );
      }
    );
  }
}

/** Physical effect lifetime stays owned by BrowserActionFlight after a response times out. */
export async function performLeaseAction(
  host: LeaseActionHost,
  input: LocalBrowserAction,
  dispatch: () => void
): Promise<LocalBrowserState> {
  host.assertAvailable();
  if (host.actions.active)
    throw new LocalBrowserError('busy', 'A browser action is finishing. Read the page again.');
  const page = host.page();
  host.refuse(page);
  const fence = actionFence(
    input,
    host.observation,
    Boolean(host.nodes),
    host.revision,
    host.stale
  );
  if (input.kind === 'navigate') host.assertDestination(input.url);
  try {
    await host.actions.run(
      async (admit, dispatched) => {
        admit();
        await performPageAction(
          page,
          host.observation,
          host.nodes,
          input,
          admit,
          dispatched,
          host.stale
        );
      },
      () => host.admit(fence),
      dispatch,
      host.invalidate
    );
  } catch (error) {
    host.refuse(page);
    if (error instanceof LocalBrowserError) throw error;
    throw new LocalBrowserError(
      'uncertain',
      'The page changed. Check what happened before continuing.'
    );
  }
  host.refuse(page);
  return host.state();
}
