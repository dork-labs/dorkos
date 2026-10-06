import { randomBytes } from 'node:crypto';
import { createInstallationFilesystem } from './filesystem.js';
import { createInstallationJobs } from './jobs.js';
import { createRuntimeStatus } from './status.js';
import { createInstallationTransaction } from './transaction.js';
import {
  InstallationConfigurationSchema,
  InstallationFailure,
  type InstallationConfiguration,
  type InstallOptions,
  type InspectOptions,
  type InstallResult,
  type RuntimeInstallation,
  type InstallationFilesystem,
  type InstallationJobs,
} from './contracts.js';

export type {
  InstallationConfiguration,
  InstallOptions,
  InspectOptions,
  InstallResult,
  RuntimeInstallation,
  RuntimeInstallationStatus,
} from './contracts.js';

/** Trusted installed-package composition; this neither activates browsing nor resolves personal profiles. */
export function createRuntimeInstallation(
  configuration: InstallationConfiguration
): RuntimeInstallation {
  const parsed = InstallationConfigurationSchema.safeParse(configuration);
  if (!parsed.success) throw new InstallationFailure('INVALID_INSTALL_CONFIGURATION');
  const config = Object.freeze({
    ...parsed.data,
    sourceVintage: Object.freeze(parsed.data.sourceVintage),
  });
  const status = createRuntimeStatus(config);
  let active: Promise<InstallResult> | null = null;
  let activeExistingOnly = false;
  // Strong references preserve original duties after uncertainty. No recovery is inferred
  // from a resolved DTO or from garbage collection; the same result blocks a new attempt.
  const owners = new Set<
    Readonly<{
      filesystem: InstallationFilesystem;
      jobs: InstallationJobs;
      transaction: ReturnType<typeof createInstallationTransaction>;
    }>
  >();
  let generation = 0;
  const facade: RuntimeInstallation = Object.freeze({
    verifyExisting(options: InspectOptions = {}): Promise<InstallResult> {
      if (active && !activeExistingOnly) {
        // Another operation is not this fresh existing-only verification. Do not borrow its result.
        return Promise.resolve(
          Object.freeze({
            state: 'refused' as const,
            cause: 'PUBLICATION_BUSY' as const,
            publicationMayHaveChanged: false,
            readiness: Object.freeze({
              state: 'unavailable' as const,
              cause: 'VERIFICATION_UNAVAILABLE' as const,
            }),
          })
        );
      }
      return facade.install({ signal: options.signal, existingOnly: true });
    },
    inspectExisting: status.inspectExisting.bind(status),
    install(options: InstallOptions = {}): Promise<InstallResult> {
      if (active) return active;
      if (generation === Number.MAX_SAFE_INTEGER)
        return Promise.resolve<InstallResult>(
          Object.freeze({
            state: 'refused',
            cause: 'OWNERSHIP_UNCERTAIN',
            publicationMayHaveChanged: false,
            readiness: Object.freeze({ state: 'unavailable', cause: 'VERIFICATION_UNAVAILABLE' }),
          })
        );
      const ownerGeneration = ++generation;
      const copied = Object.freeze({ ...options });
      let owner:
        | Readonly<{
            filesystem: InstallationFilesystem;
            jobs: InstallationJobs;
            transaction: ReturnType<typeof createInstallationTransaction>;
          }>
        | undefined;
      const operation = Promise.resolve().then(() => {
        const filesystem = createInstallationFilesystem(config);
        const jobs = createInstallationJobs(config);
        const transaction = createInstallationTransaction(
          config,
          {
            filesystem,
            jobs,
            // hrtime shares a host monotonic origin across actual Node processes.
            now: () => Number(process.hrtime.bigint() / 1_000_000n),
            createId: () => randomBytes(16).toString('hex'),
          },
          ownerGeneration
        );
        owner = Object.freeze({ filesystem, jobs, transaction });
        owners.add(owner);
        return transaction.install(copied);
      });
      activeExistingOnly = copied.existingOnly === true;
      active = operation;
      void operation
        .then(
          (result) => {
            if (!owner) return;
            const files = owner.filesystem.custody();
            const jobs = owner.jobs.custody();
            const returned =
              files.reservation === 'released' &&
              files.pendingOperations === 0 &&
              files.unresolvedHandles === 0 &&
              files.firstCause === null &&
              jobs.pending === 0 &&
              jobs.firstCause === null;
            if (result.state !== 'uncertain' && returned) {
              owners.delete(owner);
              if (active === operation) active = null;
            }
          },
          () => {
            // Constructors have no I/O; a rejection after acquiring an owner retains it.
            if (!owner && active === operation) active = null;
          }
        )
        .catch(() => {
          // A custody-observation failure cannot release the strong owner bank or admit retry.
        });
      return operation;
    },
  });
  return facade;
}

/** Actual packaged provenance only; fresh verification and native owner readiness remain separate. */
export { resolveInstalledRuntimeConfiguration, resolveInstalledNativeJournal } from './packaged.js';

/** Original read-only native support probe; never a browser authority grant. */
export { verifyInstalledNativeJournal } from './native-mode.js';
