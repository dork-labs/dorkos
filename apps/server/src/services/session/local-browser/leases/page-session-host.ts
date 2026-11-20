import type { LocalBrowserProfileChoice } from '@dorkos/shared/local-browser';
import type { BrowserProfileRemoval } from '../profile-removal/index.js';
import type { AgentWindowNames } from '../agent-window/index.js';
import type { BrowserLeaseAuditWriter } from './lease-journal.js';

/** Server-owned shared services; these callbacks never come from tool or route inputs. */
export interface PageSessionHost {
  removal: BrowserProfileRemoval;
  names: AgentWindowNames;
  profile?: () => LocalBrowserProfileChoice | undefined;
  agentId?: () => Promise<string | undefined>;
  leaseAudit?: BrowserLeaseAuditWriter;
  closed?: () => void;
  assertAgentAction?: () => void;
  drainProfile?: () => Promise<void>;
}
