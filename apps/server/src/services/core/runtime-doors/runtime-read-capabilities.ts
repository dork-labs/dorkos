/**
 * The app's runtime setup reads on `/api/runtimes/*` as capabilities the mount
 * serves (ADR 261123-170830, DOR-4978): account usage, the Claude account
 * folders found on this computer, which accounts may work in a project,
 * whether a runtime's key is saved, the OpenCode "your own key" form, and the
 * DorkOS model setup.
 *
 * Every one is person-only (`http.audience: 'person'`): account labels,
 * folder paths and key hints are the person's own, and these are the
 * person's settings screens. Agents read account usage with their own
 * `accounts_usage` tool, which runs at their turn's power; nothing here gives
 * an agent a new door to credentials, sign-ins or account settings. The
 * key-status and model-setup reads also stay at this computer, as their hand
 * routes did, from the mount's yes/no fact (`context.request`), never a header.
 *
 * The reads themselves run on the computer side and are wired in by the
 * composition layer ({@link setRuntimeSettingsReader}), so this front-door
 * module never imports runtime code. No read answers with a secret: a saved
 * key is at most its last four characters, and the model setup leaves out its
 * key reference.
 *
 * @module services/core/runtime-doors/runtime-read-capabilities
 */
import { z } from 'zod';
import {
  AccountUsageSchema,
  FoundClaudeFolderSchema,
  LEDGER_RUNTIMES,
  type AccountUsage,
  type FoundClaudeFolder,
  type LedgerRuntime,
} from '@dorkos/shared/account-usage';
import {
  AccountEligibilityQuerySchema,
  AccountEligibilityResponseSchema,
  type AccountEligibilityResponse,
} from '@dorkos/shared/project-schemas';
import {
  CREDENTIAL_RUNTIME_TYPES,
  DoeInferenceStatusSchema,
  OpenCodeDirectSetupSchema,
  RuntimeKeyStatusSchema,
  type DoeInferenceStatus,
  type OpenCodeDirectSetup,
  type RuntimeKeyStatus,
} from '@dorkos/shared/runtime-connect-schemas';

import {
  CapabilityToolError,
  defineCapability,
  type CapabilityDeps,
  type CapabilityDomain,
} from '../capabilities/capability-definition.js';
import type { CapabilityHandlerContext } from '../capabilities/index.js';
import { RUNTIME_READ_SENTENCES as SAYS } from './runtime-read-refusals.js';

/**
 * What the reads ask the computer that runs the runtimes. Each one answers
 * secret-free; a failure throws, and the capability answers it with a fixed
 * sentence, never the failure's own words.
 */
export interface RuntimeSettingsReader {
  /**
   * A runtime's accounts and their usage, or `null` before the usage store runs.
   *
   * @param runtime - A runtime that keeps a usage ledger.
   */
  accountUsage(runtime: LedgerRuntime): AccountUsage[] | null;
  /** The Claude account folders on this computer that are not registered, default or hidden. */
  foundAccounts(): FoundClaudeFolder[];
  /**
   * Every Claude account as a folder's project sees it, or `outside` for a
   * folder outside the folders DorkOS may open. Records nothing.
   *
   * @param folder - Any folder, or undefined for a folder in no project.
   */
  accountEligibility(folder: string | undefined): Promise<AccountEligibilityResponse | 'outside'>;
  /**
   * Whether a runtime's own key is saved, and its last four characters.
   *
   * @param type - A runtime with a native key path.
   */
  runtimeKeyStatus(type: (typeof CREDENTIAL_RUNTIME_TYPES)[number]): Promise<RuntimeKeyStatus>;
  /** The saved OpenCode service, its address, and whether its key is saved. */
  openCodeKeySetup(): Promise<OpenCodeDirectSetup>;
  /** The saved DorkOS model setup, without its key reference. */
  doeInference(): DoeInferenceStatus;
}

/** Set by the running server; absent, every read says the runtimes are still starting. */
let reader: RuntimeSettingsReader | undefined;

/**
 * Teach the runtime reads where to read.
 *
 * @param next - The reader; `undefined` leaves the reads answering that they are not ready.
 */
export function setRuntimeSettingsReader(next: RuntimeSettingsReader | undefined): void {
  reader = next;
}

/** The reader, or the refusal for a server that has not wired one. */
function readerOf(): RuntimeSettingsReader {
  if (!reader) {
    throw new CapabilityToolError({
      code: 'RUNTIMES_UNAVAILABLE',
      error: SAYS.notReady,
    });
  }
  return reader;
}

/** The refusal for a key or model read from anywhere but this computer, as the hand routes said it. */
const NOT_LOCAL = { connect: SAYS.connectNotLocal, model: SAYS.modelNotLocal } as const;

/** Refuse a caller that is not at this computer, or that came with a program key. */
function assertAtThisComputer(context: CapabilityHandlerContext, which: keyof typeof NOT_LOCAL) {
  if (context.request?.atThisComputerWithoutProgramKey) return;
  throw new CapabilityToolError({ code: 'RUNTIMES_NOT_LOCAL', error: NOT_LOCAL[which] });
}

/**
 * Run one read; a failure is logged without its detail (it can carry a path)
 * and answered with the hand route's fixed sentence.
 */
async function reading<T>(deps: CapabilityDeps, sentence: string, run: () => T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CapabilityToolError) throw error;
    deps.logger.error(`[Runtimes] ${sentence}`);
    throw new CapabilityToolError({ code: 'RUNTIMES_READ_FAILED', error: sentence });
  }
}

/** Why these reads are person-only, for the catalog. */
const PERSON_ONLY_NOTE =
  'a person’s own runtime settings screen; agents read account usage with accounts_usage';

/** `runtimes.account_usage`: how much of each of a runtime's accounts is used. */
export const accountUsageCapability = defineCapability({
  id: 'runtimes.account_usage',
  title: 'Read account usage',
  description:
    "Every account of the runtime with its usage windows, from the server's memory: registered " +
    'accounts in registry order, the machine-wide `default` account when it is not another ' +
    'name for a registered one, then folders that are neither (with a null `accountId`). An ' +
    'account with nothing to go on reads `state: "unknown"`, never zero.',
  tier: 'observe',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: z.object({ runtime: z.enum(LEDGER_RUNTIMES).describe('The runtime slug.') }),
  output: z.object({ accounts: z.array(AccountUsageSchema) }),
  surfaces: {
    http: {
      method: 'get',
      path: '/api/runtimes/{type}/accounts/usage',
      params: { type: 'runtime' },
      audience: 'person',
    },
  },
  invoke: async (_deps, { runtime }) => {
    const accounts = readerOf().accountUsage(runtime);
    if (!accounts) {
      throw new CapabilityToolError({
        code: 'ACCOUNT_USAGE_UNAVAILABLE',
        error: SAYS.usageUnavailable,
      });
    }
    return { accounts };
  },
});

/** `runtimes.found_accounts`: the Claude account folders found on this computer. */
export const foundAccountsCapability = defineCapability({
  id: 'runtimes.found_accounts',
  title: 'List the Claude account folders found on this computer',
  description:
    'Every `.claude*` folder in the home folder that holds a `projects/` folder and is not a ' +
    'registered account, the machine default or a hidden folder, sorted by name. Folders are ' +
    'listed and statted; no file is opened. Nothing is registered until a person adds one.',
  tier: 'observe',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: z.object({}),
  output: z.object({ folders: z.array(FoundClaudeFolderSchema) }),
  surfaces: {
    http: { method: 'get', path: '/api/runtimes/claude-code/accounts/found', audience: 'person' },
  },
  invoke: async (deps) => ({
    folders: await reading(deps, SAYS.foundFailed, () => readerOf().foundAccounts()),
  }),
});

/** `runtimes.account_eligibility`: which Claude accounts may work in a folder's project. */
export const accountEligibilityCapability = defineCapability({
  id: 'runtimes.account_eligibility',
  title: 'Read which Claude accounts may work in a project',
  description:
    'Every Claude account (Main is `default`) as the project a folder belongs to sees it. An ' +
    'account may work in a project only when both rules allow it: its own (`onlyProjects`) and ' +
    'the project’s (`allow`). `launch` is what a new chat in the folder would run on. Leave out ' +
    '`project` for a folder in no project. Records nothing.',
  tier: 'observe',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: AccountEligibilityQuerySchema,
  output: AccountEligibilityResponseSchema,
  surfaces: {
    http: {
      method: 'get',
      path: '/api/runtimes/claude-code/account-eligibility',
      audience: 'person',
    },
  },
  invoke: async (deps, { project }) => {
    const answer = await reading(deps, SAYS.eligibilityFailed, () =>
      readerOf().accountEligibility(project)
    );
    if (answer === 'outside') {
      throw new CapabilityToolError({
        code: 'OUTSIDE_FOLDER',
        error: SAYS.outsideFolder,
      });
    }
    return answer;
  },
});

/** `runtimes.key_status`: whether a runtime's own key is saved. */
export const runtimeKeyStatusCapability = defineCapability({
  id: 'runtimes.key_status',
  title: 'Read whether a runtime’s key is saved',
  description:
    'Whether Claude Code’s or Codex’s own pasted key is saved, and its last four characters ' +
    'when it is; never more of the key. Codex always reads not saved: its key lives in Codex’s ' +
    'own login store. Only at this computer.',
  tier: 'observe',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: z.object({ type: z.enum(CREDENTIAL_RUNTIME_TYPES).describe('The runtime.') }),
  output: RuntimeKeyStatusSchema,
  surfaces: {
    http: { method: 'get', path: '/api/runtimes/{type}/credential', audience: 'person' },
  },
  invoke: async (deps, { type }, context) => {
    assertAtThisComputer(context, 'connect');
    return reading(deps, SAYS.keyFailed, () => readerOf().runtimeKeyStatus(type));
  },
});

/** `runtimes.opencode_key_setup`: what the OpenCode "your own key" form shows when reopened. */
export const openCodeKeySetupCapability = defineCapability({
  id: 'runtimes.opencode_key_setup',
  title: 'Read the OpenCode key setup',
  description:
    'The service OpenCode was pointed at with your own key, its address, and whether a key is ' +
    'saved (its last four characters only). Only at this computer.',
  tier: 'observe',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: z.object({}),
  output: OpenCodeDirectSetupSchema,
  surfaces: {
    http: { method: 'get', path: '/api/runtimes/opencode/provider', audience: 'person' },
  },
  invoke: async (deps, _input, context) => {
    assertAtThisComputer(context, 'connect');
    return reading(deps, SAYS.setupFailed, () => readerOf().openCodeKeySetup());
  },
});

/** `runtimes.doe_model_setup`: the saved DorkOS model setup. */
export const doeModelSetupCapability = defineCapability({
  id: 'runtimes.doe_model_setup',
  title: 'Read the DorkOS model setup',
  description:
    'The saved DorkOS model setup without its key reference, whether a key is saved, and the ' +
    'format DorkOS picks a credits model in when nothing is set. Only at this computer.',
  tier: 'observe',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: z.object({}),
  output: DoeInferenceStatusSchema,
  surfaces: { http: { method: 'get', path: '/api/runtimes/doe/inference', audience: 'person' } },
  invoke: async (deps, _input, context) => {
    assertAtThisComputer(context, 'model');
    return reading(deps, SAYS.modelSetupFailed, () => readerOf().doeInference());
  },
});

/** The app's runtime setup reads; on every server. */
export const runtimeReadsDomain: CapabilityDomain = {
  name: 'runtimes',
  capabilities: [
    accountUsageCapability,
    foundAccountsCapability,
    accountEligibilityCapability,
    runtimeKeyStatusCapability,
    openCodeKeySetupCapability,
    doeModelSetupCapability,
  ],
};
