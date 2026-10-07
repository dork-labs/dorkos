import { mkdtemp, rm } from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrowserContext } from 'playwright-core';
import type { BrowserRuntimeDescriptor } from '../../../runtime-descriptor.js';
import type { ProcessIdentity } from '../../../configuration.js';
import {
  ownDirectory,
  assertDirectory,
  type OwnedDirectory,
} from '../../../profiles/owned-directory.js';
import { launchDarwinSupervisorBrowser } from '../../darwin-supervisor-browser.js';
import { createDarwinEngineProcesses } from '../../darwin-engine-processes.js';
import { acceptsDarwinOwnedChildReturn, type DarwinOwnedChild } from '../../darwin-owned-child.js';
import { createSupervisorIdentityAcceptance } from '../supervisor-identity-acceptance.js';
import { sampleFixtureOriginalMatrix } from './fixture-original-matrix.js';
import { candidateOriginals } from './fixture-production-cohort.js';

/** Private acceptance wrapper over the exact production producer and launcher. It supplies
 * a genuine pinned HTTPS peer, never a baseline/UA/SDK override or public availability flag. */
export function createFixtureProductionChromeSupervisor(
  options: Readonly<{
    nativeRuntime: BrowserRuntimeDescriptor;
    compatibleRuntime: BrowserRuntimeDescriptor;
    artifact: Readonly<{ path: string; sha256: string }>;
    manager: ProcessIdentity;
    fixtureURL: string;
    certificateSPKI: string;
    mutant?: 'missing-first-init-ack';
  }>
) {
  const native = createDarwinEngineProcesses(options.artifact);
  const known = new Map<string, ProcessIdentity>();
  const baseline = new Map<string, ProcessIdentity>();
  const candidate = new Map<string, ProcessIdentity>();
  let candidateCohortComplete = false,
    candidateCaptureFailed = false;
  const duties = new Set<Promise<unknown>>();
  let stopped = false,
    first: Readonly<{ value: unknown }> | undefined;
  let directory: OwnedDirectory | undefined;
  let original: Awaited<ReturnType<typeof launchDarwinSupervisorBrowser>> | undefined;
  let opening: Promise<BrowserContext> | undefined,
    closing: Promise<ReturnType<typeof snapshot>> | undefined;
  let wholeShutdown: Promise<void> | undefined;
  let root: ProcessIdentity | undefined;
  let originalChildReturned = false,
    descendantsReturned = false,
    profileRemoved = false;
  const closedAdmission = new Error('PRODUCTION_ACCEPTANCE_CLOSED');
  const note = (value: unknown) => {
    if (value !== closedAdmission) first ??= { value };
  };
  const guard = () => {
    if (stopped || first) throw first ? first.value : closedAdmission;
  };
  const track = <T>(_label: string, produce: () => Promise<T> | T): Promise<T> => {
    const work = Promise.resolve().then(produce);
    duties.add(work);
    void work.then(
      () => duties.delete(work),
      (value) => {
        note(value);
        duties.delete(work);
      }
    );
    return work;
  };
  const remember = (identities: readonly ProcessIdentity[]) => {
    for (const identity of identities) {
      const key = identity.pid + ':' + identity.birth;
      if (!known.has(key) && known.size >= 1024)
        throw new Error('PRODUCTION_ACCEPTANCE_NATIVE_BIRTH_BOUND');
      known.set(key, Object.freeze({ ...identity }));
    }
  };
  const captureCandidate = async () => {
    if (!root) throw new Error('PRODUCTION_ACCEPTANCE_ROOT_UNOBSERVED');
    remember([root]);
    if (!candidate.has(root.pid + ':' + root.birth))
      candidate.set(root.pid + ':' + root.birth, Object.freeze({ ...root }));
    const tree = await track('candidate.originalCompleteTree', () =>
      native.processes.descendants(root!, new AbortController().signal)
    ).catch((value) => {
      candidateCaptureFailed = true;
      candidateCohortComplete = false;
      throw value;
    });
    if (tree.status !== 'complete') {
      candidateCaptureFailed = true;
      candidateCohortComplete = false;
      throw new Error('PRODUCTION_ACCEPTANCE_TREE_UNKNOWN');
    }
    try {
      const rows = candidateOriginals(root, tree.identities);
      for (const identity of rows) {
        const key = identity.pid + ':' + identity.birth;
        if (!candidate.has(key) && candidate.size >= 512)
          throw new Error('PRODUCTION_ACCEPTANCE_CANDIDATE_BIRTH_BOUND');
        candidate.set(key, identity);
      }
      candidateOriginals(root, [...candidate.values()]);
      remember(rows);
      candidateCohortComplete = !candidateCaptureFailed;
    } catch (value) {
      candidateCaptureFailed = true;
      candidateCohortComplete = false;
      throw value;
    }
  };
  const acceptance = createSupervisorIdentityAcceptance({
    ...options,
    onOriginalChild: async (child) => {
      // This registration is joined before production initialization or its failure can stop child.
      root = await track('candidate.originalRootBirth', () => child.identity());
      await captureCandidate();
    },
  });
  const snapshot = () =>
    Object.freeze({
      state:
        !first && originalChildReturned && descendantsReturned && profileRemoved
          ? ('closed' as const)
          : ('held' as const),
      originalChildReturned,
      descendantsReturned,
      profileRemoved,
      root,
      candidateCohortComplete,
      candidateOriginals: [...candidate.values()].map((value) => Object.freeze({ ...value })),
      identityAcknowledgementWithheld: acceptance.identityAcknowledgementWithheld(),
      knownBaselineOriginals: [...baseline.values()].map((value) => Object.freeze({ ...value })),
    });
  const owner = Object.freeze({
    open(): Promise<BrowserContext> {
      if (opening) return opening;
      opening = track('whole.production.open', async () => {
        guard();
        const path = await track('profile.mkdtemp', () =>
          mkdtemp(join(tmpdir(), 'production-chrome-matrix-'))
        );
        // Capture the no-follow canonical identity before any native launch/removal.
        const raw = lstatSync(path);
        if (!raw.isDirectory() || raw.isSymbolicLink())
          throw new Error('PRODUCTION_ACCEPTANCE_PROFILE_UNOWNED');
        directory = ownDirectory(realpathSync(path));
        if (directory.dev !== raw.dev || directory.ino !== raw.ino)
          throw new Error('PRODUCTION_ACCEPTANCE_PROFILE_REPLACED');
        guard();
        assertDirectory(directory);
        const lease = await track('peer.open', () => acceptance.open());
        guard();
        original = await track('production.launch', () =>
          launchDarwinSupervisorBrowser(
            {
              manager: options.manager,
              runtime: options.compatibleRuntime,
              artifact: options.artifact,
              profileDir: directory!.path,
              origin: 'about:blank',
              identityPreparation: { nativeRuntime: options.nativeRuntime },
              originalIdentityAcceptance: lease,
            },
            () => note(new Error('PRODUCTION_ACCEPTANCE_CUSTODY_FAULT')),
            undefined,
            undefined,
            async (identities) => {
              remember(identities);
              for (const identity of identities)
                baseline.set(identity.pid + ':' + identity.birth, Object.freeze({ ...identity }));
            },
            () => !stopped
          )
        );
        root = original.root;
        remember([root]);
        await captureCandidate();
        guard();
        return original.context;
      });
      return opening;
    },
    nativeBaseline: () => acceptance.nativeBaseline(),
    baselineOriginals: () => [...baseline.values()].map((value) => Object.freeze({ ...value })),
    sampleMatrix() {
      return track('whole.production.sample', async () => {
        guard();
        if (!original) throw new Error('PRODUCTION_ACCEPTANCE_ORIGINAL_MISSING');
        await captureCandidate();
        guard();
        const values = await sampleFixtureOriginalMatrix(
          original.context,
          options.fixtureURL,
          guard,
          track
        );
        await captureCandidate();
        guard();
        return values;
      });
    },
    close(_deadline: number) {
      if (closing) return closing;
      stopped = true;
      // Reserve the full cleanup before acquiring/entering any original close receiver.
      wholeShutdown = Promise.resolve().then(async () => {
        // The stopped constructor fence cancels launch. A still-opening peer's sockets are
        // stopped independently so a pending CONNECT/TLS probe cannot hold the original.
        const peerClose = acceptance.close();
        void peerClose.catch(note);
        if (opening) await Promise.allSettled([opening]);
        const child: DarwinOwnedChild | undefined = acceptance.child();
        if (child) {
          try {
            root = await child.identity();
            remember([root]);
            // Root/cohort was captured at original birth before any failed launch could stop it.
            // Refresh still-live candidate; a known returned child cannot manufacture a new tree.
            if (child.custody().pending) await captureCandidate();
          } catch (value) {
            note(value);
          }
        }
        if (original)
          try {
            if (!(await original.close())) note(new Error('PRODUCTION_ACCEPTANCE_CLOSE_HELD'));
          } catch (value) {
            note(value);
          }
        try {
          await acceptance.joinOriginalShutdown();
        } catch (value) {
          note(value);
        }
        for (const result of await Promise.allSettled([peerClose, ...duties]))
          if (result.status === 'rejected') note(result.reason);
        if (child)
          try {
            const returned = await child.returned();
            originalChildReturned = !!returned && acceptsDarwinOwnedChildReturn(child, returned);
          } catch (value) {
            note(value);
          }
        const outcomes = await Promise.allSettled(
          [...known.values()].map((identity) =>
            native.processes.observe(identity, new AbortController().signal)
          )
        );
        descendantsReturned =
          !!root &&
          candidateCohortComplete &&
          candidate.size > 0 &&
          outcomes.length > 0 &&
          outcomes.every((value) => value.status === 'fulfilled' && value.value.status === 'dead');
        for (const result of outcomes) if (result.status === 'rejected') note(result.reason);
        if (directory && originalChildReturned && descendantsReturned)
          try {
            assertDirectory(directory);
            await rm(directory.path, { recursive: true, force: false });
            profileRemoved = true;
          } catch (value) {
            note(value);
          }
      });
      closing = wholeShutdown.then(snapshot);
      return closing;
    },
    async joinOriginalShutdown() {
      if (wholeShutdown) await wholeShutdown;
    },
  });
  return owner;
}
