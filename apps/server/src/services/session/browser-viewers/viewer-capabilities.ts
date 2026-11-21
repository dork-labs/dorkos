import {
  localBrowserCapabilities,
  type LocalBrowserHostFacts,
} from '../local-browser/presentation.js';
import { env } from '../../../env.js';

/** The person UI learns only whether the default-off local stream is offered. */
export function browserViewerCapabilities(embedded: boolean, host: LocalBrowserHostFacts) {
  return {
    ...localBrowserCapabilities(embedded, host),
    watchStream: env.DORKOS_AGENT_BROWSER_STREAM,
  };
}
