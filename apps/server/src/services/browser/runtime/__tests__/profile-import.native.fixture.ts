import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  resolveInstalledRuntimeConfiguration,
  verifyInstalledNativeJournal,
} from '@dorkos/browser/runtime-installation';
import {
  BrowserProductionProfileCreateReceiptSchema,
  BrowserProductionProfileImportReceiptSchema,
  BrowserProductionOpenReceiptSchema,
  BrowserProductionNavigateReceiptSchema,
  BrowserLocalDestinationReceiptSchema,
  BrowserControlSchema,
  BrowserCloseReceiptSchema,
} from '@dorkos/shared/browser-schemas';
import { verifyPublicNativeEmits, type PublicNativeInput } from './public-native-input.js';
import { withOriginalInstalledBrowserRound } from './private-storage-runner.fixture.js';
import {
  createOriginalStorageOrigin,
  requireOriginalStorage,
  requireOriginalClean,
} from './private-storage-origin.fixture.js';

/** Genuine installed-CLI import/restart control; this function is never an ordinary unit-test arm. */
export async function runOriginalProfileImportWindow(options: {
  input: PublicNativeInput;
  node: string;
  artifacts: string;
  signal: AbortSignal;
  current(): void;
  retain(report: unknown): Promise<void>;
  retainRetirement?: (report: unknown) => Promise<void>;
}) {
  const guard = () => {
    options.current();
    options.signal.throwIfAborted();
  };
  const retain = options.retain.bind(options);
  const retainRetirement = options.retainRetirement?.bind(options);
  await verifyPublicNativeEmits(options.input, guard);
  const configuration = await resolveInstalledRuntimeConfiguration(
    pathToFileURL(options.input.cliEntry),
    options.input.home
  );
  const native = await verifyInstalledNativeJournal(configuration);
  const origin = await createOriginalStorageOrigin(options.signal);
  const closeOrigin = origin.close.bind(origin);
  const profiles = new Map<'A' | 'B', string>();
  const prior = new Set<string>();
  let existingCache: number | undefined;
  let first: Readonly<{ value: unknown }> | undefined;
  try {
    for (let round = 0; round < 2; round++) {
      await withOriginalInstalledBrowserRound(
        { ...options, native, round, retainRetirement },
        async (port) => {
          if (round === 0) {
            const requestId = randomUUID();
            const created = BrowserProductionProfileCreateReceiptSchema.parse(
              await port.request('/api/browser/runtime/profiles', {
                requestId,
                label: 'Existing import control ' + requestId,
              })
            );
            if (created.requestId !== requestId || created.profile.status !== 'available')
              throw new Error('IMPORT_ORIGINAL_PROFILE_REQUIRED');
            profiles.set('A', created.profile.profileId);
          }
          const open = async (subject: 'A' | 'B' | 'clean', seed = false) => {
            guard();
            const requestId = randomUUID();
            const opened = BrowserProductionOpenReceiptSchema.parse(
              await port.request('/api/browser/runtime/open', {
                workspaceId: options.input.workspaceId,
                request: {
                  requestId,
                  mode: subject === 'clean' ? 'ephemeral' : 'persistent',
                  ...(subject === 'clean' ? {} : { profileId: profiles.get(subject) }),
                },
              })
            );
            if (
              opened.requestId !== requestId ||
              prior.has(opened.binding.browserId) ||
              (subject !== 'clean' &&
                (opened.instance.mode !== 'persistent' ||
                  opened.instance.profileId !== profiles.get(subject)))
            )
              throw new Error('IMPORT_ORIGINAL_NEW_GENERATION_REQUIRED');
            prior.add(opened.binding.browserId);
            await port.birth(opened.binding);
            const control = BrowserControlSchema.parse(
              await port.request('/api/browser/control', opened.binding)
            );
            if (control.status !== 'ready' || !control.controllerId)
              throw new Error('IMPORT_ORIGINAL_CONTROL_REQUIRED');
            const permissionId = randomUUID();
            const permission = BrowserLocalDestinationReceiptSchema.parse(
              await port.request('/api/browser/runtime/local-destination', {
                requestId: permissionId,
                binding: control.binding,
                endpoint: origin.origin + '/',
                ttlMilliseconds: 300000,
              })
            );
            if (permission.requestId !== permissionId || permission.endpoint !== origin.origin)
              throw new Error('IMPORT_ORIGINAL_DESTINATION_REQUIRED');
            const url = new URL('/page', origin.origin);
            for (const [key, value] of Object.entries({
              subject,
              round: subject === 'clean' ? '0' : String(round),
              pageId: opened.binding.tabId,
              seed: seed ? '1' : '0',
            }))
              url.searchParams.set(key, value);
            const navigationId = randomUUID();
            const navigated = BrowserProductionNavigateReceiptSchema.parse(
              await port.request('/api/browser/runtime/navigate', {
                controllerId: control.controllerId,
                command: {
                  kind: 'navigate',
                  requestId: navigationId,
                  binding: control.binding,
                  url: url.href,
                },
              })
            );
            if (
              navigated.requestId !== navigationId ||
              navigated.binding.browserId !== opened.binding.browserId ||
              navigated.binding.tabId !== opened.binding.tabId
            )
              throw new Error('IMPORT_ORIGINAL_NAVIGATION_REQUIRED');
            const report = await origin.ready(
              subject,
              subject === 'clean' ? 0 : round,
              opened.binding.tabId,
              port.signal
            );
            await retain({
              kind: 'original-profile-import-read',
              round,
              subject,
              binding: navigated.binding,
              report,
            });
            return { opened, report };
          };
          const existing = await open('A', round === 0);
          if (round === 0) existingCache = existing.report.httpCache;
          if (existingCache === undefined)
            throw new Error('IMPORT_ORIGINAL_EXISTING_CACHE_REQUIRED');
          requireOriginalStorage(existing.report, {
            subject: 'A',
            round,
            pageId: existing.opened.binding.tabId,
            httpCache: existingCache,
            mutation: 0,
          });
          const closeId = randomUUID();
          const closed = BrowserCloseReceiptSchema.parse(
            await port.request('/api/browser/instances/close', {
              requestId: closeId,
              browserId: existing.opened.binding.browserId,
              browserGeneration: existing.opened.binding.browserGeneration,
            })
          );
          if (
            closed.requestId !== closeId ||
            closed.browserId !== existing.opened.binding.browserId ||
            closed.browserGeneration !== existing.opened.binding.browserGeneration ||
            closed.cleanup !== 'observed'
          )
            throw new Error('IMPORT_ORIGINAL_EXISTING_CLOSE_REQUIRED');
          if (round === 0) {
            const requestId = randomUUID();
            const imported = BrowserProductionProfileImportReceiptSchema.parse(
              await port.request('/api/browser/runtime/profiles/import', {
                requestId,
                label: 'Explicit import control ' + requestId,
                workspaceId: options.input.workspaceId,
                storageState: {
                  cookies: [
                    {
                      name: 'dork_fixture',
                      value: 'fixture-beta',
                      domain: '127.0.0.1',
                      path: '/',
                      expires: Math.floor(Date.now() / 1000) + 86400,
                      httpOnly: false,
                      secure: false,
                      sameSite: 'Lax',
                    },
                  ],
                  origins: [
                    {
                      origin: origin.origin,
                      localStorage: [{ name: 'identity', value: 'fixture-beta' }],
                    },
                  ],
                },
              })
            );
            if (
              imported.requestId !== requestId ||
              imported.profile.status !== 'available' ||
              imported.profile.profileId === profiles.get('A')
            )
              throw new Error('IMPORT_ORIGINAL_NEW_PROFILE_REQUIRED');
            profiles.set('B', imported.profile.profileId);
            await retain({ kind: 'original-profile-import-receipt', receipt: imported });
          }
          const imported = await open('B');
          if (
            imported.report.cookie !== 'fixture-beta' ||
            imported.report.localStorage !== 'fixture-beta' ||
            ['indexedDB', 'cacheStorage', 'serviceWorker', 'sessionCookie', 'sessionStorage'].some(
              (key) => Reflect.get(imported.report, key) !== null
            )
          )
            throw new Error('IMPORT_ORIGINAL_SCOPED_STORAGE_REQUIRED');
          const clean = await open('clean');
          requireOriginalClean(clean.report, clean.opened.binding.tabId, [
            existing.report.httpCache,
            imported.report.httpCache,
          ]);
        }
      );
    }
  } catch (value) {
    first = { value };
  }
  try {
    await closeOrigin();
  } catch (value) {
    first ??= { value };
  }
  if (first) throw first.value;
}
