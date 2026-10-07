import { createHash, randomUUID } from 'node:crypto';
import { lstat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  BrowserProductionOpenReceiptSchema,
  BrowserProductionNavigateReceiptSchema,
  BrowserControlSchema,
} from '@dorkos/shared/browser-schemas';
import {
  resolveInstalledRuntimeConfiguration,
  createRuntimeInstallation,
  verifyInstalledNativeJournal,
} from '@dorkos/browser/runtime-installation';
import { readOriginalConnectDenialBank } from '../../../runtime/private-native-projection.js';
import { withOriginalInstalledBrowserRound } from '../../../runtime/__tests__/private-storage-runner.fixture.js';
import {
  boundedOriginalFile,
  verifyPublicNativeEmits,
  type PublicNativeInput,
} from '../../../runtime/__tests__/public-native-input.js';
import { parseDestination } from '../../destination.js';
import {
  readSharedSANH2Endpoint,
  assertOriginalSharedSANH2Campaign,
} from './shared-san-h2-campaign.fixture.js';

const endpointReport = z
  .object({
    kind: z.literal('original-shared-san-h2-endpoint'),
    allowedHostname: z.string().max(253),
    deniedHostname: z.string().max(253),
    port: z.literal(443),
    completed: z.literal(true),
    observation: z
      .object({
        connections: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        rows: z
          .array(
            z
              .object({
                session: z.number().int().positive(),
                authority: z.string().max(16384),
                path: z.string().max(16384),
              })
              .strict()
          )
          .min(2)
          .max(256),
        failed: z.literal(false),
        closed: z.literal(true),
      })
      .strict(),
  })
  .strict();

/** Original upstream closure is required; JSON shape alone never supplies a denied CONNECT. */
export function qualifyOriginalSharedSANH2Report(input: {
  endpoint: unknown;
  report: unknown;
  originalProjection: unknown;
  browserId: string;
  browserGeneration: number;
}) {
  const endpoint = readSharedSANH2Endpoint(input.endpoint);
  const report = endpointReport.parse(input.report);
  if (
    report.allowedHostname !== new URL(endpoint.allowedOrigin).hostname ||
    report.deniedHostname !== new URL(endpoint.deniedOrigin).hostname
  )
    throw new Error('H2_ORIGINAL_ENDPOINT_SCOPE_REQUIRED');
  const rows = report.observation.rows.map((row) => ({
    ...row,
    authority: parseDestination({ url: 'https://' + row.authority + '/' }).authority,
  }));
  const warm = rows.filter(
    (row) => row.authority === endpoint.allowedAuthority && row.path === '/warm'
  );
  const continued = rows.filter(
    (row) => row.authority === endpoint.allowedAuthority && row.path === '/continue'
  );
  if (warm.length !== 1 || continued.length !== 1 || warm[0]!.session !== continued[0]!.session)
    throw new Error('H2_EXACT_ORIGINAL_WARM_CONTINUE_REQUIRED');
  const original = assertOriginalSharedSANH2Campaign({
    ...input,
    allowedSession: warm[0]!.session,
    rows,
  });
  return Object.freeze({
    kind: 'original-managed-shared-san-h2',
    version: 1,
    browserId: input.browserId,
    browserGeneration: input.browserGeneration,
    endpoint: original.endpoint,
    allowedSession: warm[0]!.session,
    rows: Object.freeze(rows),
    originalConnectDenials: original.originalConnectDenials,
  });
}

/** Poll only the original endpoint's exclusive report file; failures other than absence are final. */
export async function readClosedSharedSANH2Report(
  path: string,
  signal: AbortSignal,
  current: () => void
) {
  if (!isAbsolute(path)) throw new Error('H2_ORIGINAL_REPORT_PATH_REQUIRED');
  for (;;) {
    current();
    signal.throwIfAborted();
    try {
      const bytes = await boundedOriginalFile(path, 2097152, current);
      current();
      signal.throwIfAborted();
      return {
        report: JSON.parse(bytes.toString('utf8')) as unknown,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    await delay(50, undefined, { signal });
  }
}

/** Validates supplied original capture evidence; independent endpoint-owner review remains required. */
export function qualifyOriginalEndpointReturn(input: {
  receipt: unknown;
  executablePath: string;
  executableSHA256: string;
  reportPath: string;
  reportSHA256: string;
}) {
  const digest = z.string().regex(/^[a-f0-9]{64}$/);
  const receipt = z
    .object({
      kind: z.literal('original-shared-san-h2-endpoint-return'),
      executablePath: z.string().refine(isAbsolute),
      executableSHA256: digest,
      reportPath: z.string().refine(isAbsolute),
      reportSHA256: digest,
      pid: z.number().int().positive(),
      pgid: z.number().int().positive(),
      enteredAt: z.number().finite().nonnegative(),
      returnedAt: z.number().finite().nonnegative(),
      exit: z.literal(0),
      eof: z.literal(true),
      truncated: z.literal(false),
      expired: z.literal(false),
      groupAbsent: z.literal(true),
    })
    .strict()
    .parse(input.receipt);
  if (
    receipt.executablePath !== input.executablePath ||
    receipt.executableSHA256 !== input.executableSHA256 ||
    receipt.reportPath !== input.reportPath ||
    receipt.reportSHA256 !== input.reportSHA256 ||
    receipt.returnedAt < receipt.enteredAt
  )
    throw new Error('H2_ORIGINAL_ENDPOINT_RETURN_CORRELATION_REQUIRED');
  return Object.freeze(receipt);
}

/** A previous endpoint report must never be reused for a new browser campaign. */
export async function requireFreshSharedSANH2Report(path: string) {
  if (!isAbsolute(path)) throw new Error('H2_ORIGINAL_REPORT_PATH_REQUIRED');
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('H2_ORIGINAL_ENDPOINT_REPORT_ALREADY_EXISTS');
}

/** One genuine built CLI/native birth and public navigation; no Page/CDP, custom CA or policy injection. */
export async function runPrivateOriginalSharedSANH2Window(options: {
  input: PublicNativeInput;
  node: string;
  artifacts: string;
  endpoint: unknown;
  endpointReportPath: string;
  originalEndpointReturnPath: string;
  endpointExecutablePath: string;
  endpointExecutableSHA256: string;
  signal: AbortSignal;
  current(): void;
  retain(report: unknown): Promise<void>;
}) {
  const endpoint = readSharedSANH2Endpoint(options.endpoint);
  const current = () => {
    options.current();
    options.signal.throwIfAborted();
  };
  await requireFreshSharedSANH2Report(options.endpointReportPath);
  await requireFreshSharedSANH2Report(options.originalEndpointReturnPath);
  const executable = await boundedOriginalFile(options.endpointExecutablePath, 2097152, current);
  if (createHash('sha256').update(executable).digest('hex') !== options.endpointExecutableSHA256)
    throw new Error('H2_ORIGINAL_ENDPOINT_SOURCE_REQUIRED');
  await verifyPublicNativeEmits(options.input, current);
  const configuration = await resolveInstalledRuntimeConfiguration(
    pathToFileURL(options.input.cliEntry),
    options.input.home
  );
  if (
    (await createRuntimeInstallation(configuration).inspectExisting()).state !== 'installed-files'
  )
    throw new Error('H2_ORIGINAL_INSTALLED_RUNTIME_REQUIRED');
  const native = await verifyInstalledNativeJournal(configuration);
  await withOriginalInstalledBrowserRound(
    { ...options, native, round: 0, retainRetirement: options.retain.bind(options) },
    async (port) => {
      const requestId = randomUUID();
      const opened = BrowserProductionOpenReceiptSchema.parse(
        await port.request('/api/browser/runtime/open', {
          workspaceId: options.input.workspaceId,
          request: { requestId, mode: 'ephemeral' },
        })
      );
      if (opened.requestId !== requestId || opened.instance.mode !== 'ephemeral')
        throw new Error('H2_ORIGINAL_OPEN_RECEIPT_REQUIRED');
      await port.birth(opened.binding);
      const control = BrowserControlSchema.parse(
        await port.request('/api/browser/control', opened.binding)
      );
      if (control.status !== 'ready' || !control.controllerId)
        throw new Error('H2_ORIGINAL_CONTROL_REQUIRED');
      const navigationId = randomUUID();
      const navigated = BrowserProductionNavigateReceiptSchema.parse(
        await port.request('/api/browser/runtime/navigate', {
          controllerId: control.controllerId,
          command: {
            kind: 'navigate',
            requestId: navigationId,
            binding: control.binding,
            url: endpoint.warmURL,
          },
        })
      );
      if (
        navigated.requestId !== navigationId ||
        navigated.binding.browserId !== opened.binding.browserId ||
        navigated.binding.browserGeneration !== opened.binding.browserGeneration ||
        navigated.binding.tabId !== opened.binding.tabId
      )
        throw new Error('H2_ORIGINAL_NAVIGATION_REQUIRED');
      const projection = port.originalProjection();
      for (;;) {
        current();
        port.signal.throwIfAborted();
        const denied = readOriginalConnectDenialBank(projection).some(
          (row) =>
            row.browserId === opened.binding.browserId &&
            row.browserGeneration === opened.binding.browserGeneration &&
            row.authority === endpoint.deniedAuthority &&
            row.beforeDial &&
            (row.reason === 'ADMIN_DENIED' ||
              row.reason === 'ADDRESS_DENIED' ||
              row.reason === 'GRANT_REFUSED')
        );
        if (denied) break;
        await delay(50, undefined, { signal: port.signal });
      }
      await writeFile(
        join(options.artifacts, 'NETWORK-ACTIONS-RETURNED.json'),
        JSON.stringify({
          kind: 'original-shared-san-h2-actions',
          endpoint,
          navigationReturned: true,
          deniedConnectObserved: true,
        }) + '\n',
        { flag: 'wx', mode: 0o600 }
      );
      const endpointArtifact = await readClosedSharedSANH2Report(
        options.endpointReportPath,
        port.signal,
        current
      );
      const endpointReturn = await readClosedSharedSANH2Report(
        options.originalEndpointReturnPath,
        port.signal,
        current
      );
      await options.retain(
        qualifyOriginalEndpointReturn({
          receipt: endpointReturn.report,
          executablePath: options.endpointExecutablePath,
          executableSHA256: options.endpointExecutableSHA256,
          reportPath: options.endpointReportPath,
          reportSHA256: endpointArtifact.sha256,
        })
      );
      await options.retain(
        qualifyOriginalSharedSANH2Report({
          endpoint: options.endpoint,
          report: endpointArtifact.report,
          originalProjection: projection,
          browserId: opened.binding.browserId,
          browserGeneration: opened.binding.browserGeneration,
        })
      );
    }
  );
  await verifyPublicNativeEmits(options.input, current);
}
