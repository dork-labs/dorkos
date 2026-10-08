import type { QueryClient } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { applyShapeAction } from '@/layers/entities/shapes';
import { switchAgentCwd, sessionDestination } from '@/layers/entities/session';
import { executeUiCommand, type DispatcherContext, type EffectOwner } from '@/layers/shared/lib';

type AgentDependencies = Parameters<typeof switchAgentCwd>[1];
/** Private app composition: these ports are produced by main, not extensions. */
interface ActionDependencies {
  transport: Transport;
  queryClient: QueryClient;
  getStore: () => AgentDependencies['store'];
  currentLocation: AgentDependencies['currentLocation'];
  navigate: (search: Parameters<AgentDependencies['navigate']>[0], owner?: EffectOwner) => void;
  getDispatcherContext: () => DispatcherContext;
}

/** Bind the app's asynchronous actions without discarding an extension occurrence. */
export function createExtensionUiActions(deps: ActionDependencies) {
  const switchAgent = (cwd: string, owner?: EffectOwner): Promise<void> => {
    const original = switchOwnedAgent(deps, cwd, owner);
    void original.catch((error) => reportCurrentFailure(owner, error));
    return original;
  };
  const applyShape = (shape: string, owner?: EffectOwner): Promise<void> => {
    const initialDestination = sessionDestination(deps.currentLocation());
    const originalOwner = owner;
    owner = originalOwner
      ? Object.freeze({
          beforeEffect: () => {
            const destination = sessionDestination(deps.currentLocation());
            originalOwner.beforeEffect();
            if (destination !== initialDestination)
              throw new Error('Extension action was superseded.');
          },
        })
      : undefined;
    const dispatch = (command: Parameters<typeof executeUiCommand>[1]): void => {
      const context = deps.getDispatcherContext();
      owner?.beforeEffect();
      executeUiCommand(context, command, 'agent', owner);
    };
    const transport = deps.transport;
    const queryClient = deps.queryClient;
    const input = {
      transport,
      queryClient,
      dispatch,
      switchAgent: (cwd: string) => switchAgent(cwd, owner),
      effectOwner: owner,
    };
    owner?.beforeEffect();
    const original = applyShapeAction(shape, input).then(() => {});
    void original.catch((error) => reportCurrentFailure(owner, error));
    return original;
  };
  return { switchAgent, applyShape };
}

async function switchOwnedAgent(
  deps: ActionDependencies,
  cwd: string,
  owner?: EffectOwner
): Promise<void> {
  const readStore = deps.getStore;
  owner?.beforeEffect();
  const store = Reflect.apply(readStore, deps, []);
  const queryClient = deps.queryClient;
  const transport = deps.transport;
  const currentLocation = deps.currentLocation;
  const navigate = deps.navigate;
  const input: AgentDependencies = {
    store,
    queryClient,
    transport,
    currentLocation,
    effectOwner: owner,
    navigate: (search) => {
      owner?.beforeEffect();
      Reflect.apply(navigate, deps, [search, owner]);
    },
  };
  owner?.beforeEffect();
  await switchAgentCwd(cwd, input);
}

/** Preserve diagnostics for a genuine current failure; retirement grants no late UI effect. */
function reportCurrentFailure(owner: EffectOwner | undefined, error: unknown): void {
  try {
    const report = console.error;
    owner?.beforeEffect();
    Reflect.apply(report, console, ['Extension app action failed', error]);
  } catch {
    // Diagnostic failure grants no effect and cannot escape the retained action.
  }
}
