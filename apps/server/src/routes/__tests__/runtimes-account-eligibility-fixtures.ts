/**
 * The account-rule routes' test world (`runtimes-account-eligibility.test.ts`):
 * the app it serves, and the two accounts and Main it starts with.
 */
import type { RequestListener } from 'node:http';
import { createRuntimesRoutes } from '../runtimes.js';
import { runtimeSettingsReader } from '../runtime-settings-reader.js';
import {
  runtimeReadsDomain,
  setRuntimeSettingsReader,
} from '../../services/core/runtime-doors/runtime-read-capabilities.js';
import { capabilityGroup } from '../../http/__tests__/capability-group.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import type { ActivityService } from '../../services/activity/activity-service.js';
import type { AccountUsageStore } from '../../services/core/usage/account-usage-store.js';

/**
 * The routes under test: the read on the capability mount
 * (`runtimes.account_eligibility`, DOR-4978) and the writes by hand.
 *
 * @param emit - Where the writes record their Activity entries.
 */
export function accountRulesListener(emit: ActivityService['emit']): RequestListener {
  setRuntimeSettingsReader(runtimeSettingsReader());
  return honoGroupListener([
    capabilityGroup(runtimeReadsDomain),
    {
      path: '/api/runtimes',
      routes: createRuntimesRoutes({ activity: { emit } as unknown as ActivityService }),
    },
  ]);
}

/** The `runtimes` section each test starts from: two accounts and no rules. */
export function seedRuntimes(): Record<string, unknown> {
  return {
    claudeCode: {
      accounts: [
        { id: 'work', path: '/claude-work', label: 'Work', onlyProjects: null },
        { id: 'personal', path: '/claude-personal', label: null, onlyProjects: null },
      ],
      defaultAccountOnlyProjects: null,
      projectAccounts: {},
    },
  };
}

/** The usage store's accounts: the two, then Main. */
export function seedAccountStore(): AccountUsageStore {
  return {
    listAccounts: () => [
      { id: 'work', label: 'Work', color: '#111111', implicit: false, routable: true },
      { id: 'personal', label: null, color: '#222222', implicit: false, routable: true },
      { id: 'default', label: 'Main', color: '#333333', implicit: true, routable: true },
    ],
    usageOfAccount: () => ({ state: 'ok', windows: [] }),
  } as unknown as AccountUsageStore;
}
