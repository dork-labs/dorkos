import type { ProcessIdentity, ProcessObserver } from '@dorkos/browser';
import type { createPrivateNativeAcceptance } from '../private-native-acceptance.js';
import { sampleResources, resourceInterval } from './public-native-resources.js';

/** Private consumer of the original constructor projection bank. A campaign must
 * supply the two actual open receipts and original launchServer child capture;
 * missing roles refuse before measurement. It never claims a capacity ceiling. */
export async function measurePrivateOriginalResourceWindow(options: {
  bank: Pick<ReturnType<typeof createPrivateNativeAcceptance>, 'roles' | 'assertCurrent'>;
  manager: ProcessIdentity;
  nodeIdentities?: readonly ProcessIdentity[];
  processes: ProcessObserver;
  bindings: readonly Readonly<{
    browserId: string;
    browserGeneration: number;
  }>[];
  signal: AbortSignal;
  current(): void;
  own<T>(original: Promise<T>): Promise<T>;
  idle(): Promise<void>;
  active(): Promise<Readonly<{ frames: number; bytes: number }>>;
}) {
  const { bank, manager, processes, bindings, signal } = options;
  const current = options.current.bind(options),
    own = options.own.bind(options);
  const idle = options.idle.bind(options),
    active = options.active.bind(options);
  const assert = () => {
    bank.assertCurrent();
    current();
    if (signal.aborted) throw signal.reason;
  };
  const projection = await bank.roles(bindings);
  const nodeIdentities = options.nodeIdentities ?? [manager];
  if (!nodeIdentities.some((id) => id.pid === manager.pid && id.birth === manager.birth))
    throw new Error('PRIVATE_RESOURCE_ORIGINAL_NODE_REQUIRED');
  const key = (identity: ProcessIdentity) => identity.pid + ':' + identity.birth;
  const snapshot = async () => {
    assert();
    const roles = await bank.roles(bindings);
    assert();
    if (
      roles.length !== projection.length ||
      roles.some(
        (role, index) =>
          role.kind !== projection[index]!.kind ||
          key(role.root) !== key(projection[index]!.root) ||
          role.identities.length !== projection[index]!.identities.length ||
          role.identities.some(
            (row) => !projection[index]!.identities.some((known) => key(row) === key(known))
          )
      )
    )
      throw new Error('PRIVATE_RESOURCE_ORIGINAL_ROLE_COHORT_CHANGED');
    const identities = [...nodeIdentities, ...roles.flatMap((role) => role.identities)];
    if (
      new Set(identities.map((row) => row.pid)).size !== identities.length ||
      identities.length > 512
    )
      throw new Error('PRIVATE_RESOURCE_ORIGINAL_ROLE_OVERLAP');
    return identities;
  };
  const owner = {
    own,
    guard: assert,
    signal,
    snapshot,
    observe: processes.observe.bind(processes),
  };
  const baseline = await sampleResources(owner);
  await own(idle());
  assert();
  const idleEnd = await sampleResources(owner);
  const activeBegin = await sampleResources(owner);
  const payload = await own(active());
  assert();
  if (
    !Number.isSafeInteger(payload.frames) ||
    payload.frames < 1 ||
    !Number.isSafeInteger(payload.bytes) ||
    payload.bytes < 1
  )
    throw new Error('PRIVATE_RESOURCE_ORIGINAL_ACTIVE_FRAMES_REQUIRED');
  const activeEnd = await sampleResources(owner);
  const summarize = (before: typeof baseline, after: typeof baseline) => {
    const interval = resourceInterval(before, after, manager, [manager]);
    return {
      elapsedMilliseconds: interval.elapsedMilliseconds,
      counterWindows: interval.counterWindows,
      intervalBoundsMilliseconds: interval.intervalBoundsMilliseconds,
      host: interval.host,
      nodeProcesses: {
        scope: options.nodeIdentities
          ? 'original CLI Node and captured browser Node supervisors'
          : 'original server Node process',
        rows: interval.rows.filter((row) => nodeIdentities.some((id) => key(id) === key(row))),
        rssBytes: interval.rows
          .filter((row) => nodeIdentities.some((id) => key(id) === key(row)))
          .reduce((sum, row) => sum + row.rssBytes, 0),
        cpuMilliseconds: interval.rows
          .filter((row) => nodeIdentities.some((id) => key(id) === key(row)))
          .reduce((sum, row) => sum + row.cpuMilliseconds, 0),
      },
      node: { scope: 'original server Node process', ...interval.node },
      roles: projection.map((role) => {
        const rows = interval.rows.filter((row) =>
          role.identities.some((identity) => key(identity) === key(row))
        );
        if (rows.length !== role.identities.length)
          throw new Error('PRIVATE_RESOURCE_ROLE_COUNTERS_MISSING');
        return {
          ...role,
          rows,
          rssBytes: rows.reduce((sum, row) => sum + row.rssBytes, 0),
          cpuMilliseconds: rows.reduce((sum, row) => sum + row.cpuMilliseconds, 0),
          cpuPercentOneCore: rows.reduce((sum, row) => sum + row.cpuPercentOneCore, 0),
        };
      }),
    };
  };
  const idleReport = summarize(baseline, idleEnd),
    activeReport = summarize(activeBegin, activeEnd);
  assert();
  return Object.freeze({
    version: 1,
    resourceRoles: 'original births observed',
    baseline: baseline.host,
    ...(options.nodeIdentities ? { originalCounterBaseline: baseline } : {}),
    idle: idleReport,
    active: activeReport,
    payload,
    capacityAdmission: {
      status: 'UNVERIFIED',
      additionalSlots: 0,
      reason:
        'No approved CPU/RSS/load pressure limits have been supplied; observations confer no additional capacity.',
    },
    headroom: {
      observedFreeBytes: activeReport.host.after.freeBytes,
      hostCpuPercent: activeReport.host.cpuPercent,
      hostLogicalCores: activeReport.host.after.logicalCores,
      additionalSlotsAdmitted: 0,
      pressureLimits: 'UNVERIFIED; existing fixed admission limits remain unchanged',
    },
    limitations: [
      'RSS sums can count shared pages repeatedly; free RAM excludes reclaimable cache.',
      'Host CPU/load includes unrelated workloads and native observer work.',
      'CPU uses cumulative counters and bounded counter brackets; genuine zero deltas are retained.',
      'Stable complete original role cohorts are required; unknown/churn refuses measurement.',
      'No latency, tunnel, handoff or capacity acceptance from this window.',
    ],
    latency: 'UNVERIFIED in this separate resource measurement window',
  });
}
