import { z } from 'zod';
import { RuntimeDescriptorSchema, AbsolutePathSchema } from '../../../runtime-descriptor.js';
import { NativeIdentitySchema } from '../native-observation.js';
import { MatrixObservationsSchema } from './fixture-original-matrix.js';
import { createFixtureProductionChromeSupervisor as createFixtureOriginalChromeSupervisor } from './fixture-production-supervisor.js';
const nonce = z.string().uuid();
const seed = z
  .object({
    kind: z.literal('launch'),
    nonce,
    nativeRuntime: RuntimeDescriptorSchema,
    compatibleRuntime: RuntimeDescriptorSchema,
    runtimeInput: AbsolutePathSchema,
    profileHome: AbsolutePathSchema,
    manager: z
      .object({ pid: z.number().int().positive(), birth: z.string().min(1).max(128) })
      .strict(),
    artifact: z
      .object({ path: AbsolutePathSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict(),
    fixtureURL: z.string().url().max(4096),
    hostResolverRules: z.string().max(512),
    certificateSPKI: z.string().max(128),
    mutant: z.literal('missing-first-init-ack').optional(),
  })
  .strict();
const action = z
  .object({
    kind: z.enum(['sample-page', 'sample-matrix', 'close']),
    nonce,
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const primitive = (value: unknown) =>
  value === undefined
    ? ('undefined' as const)
    : value === false
      ? ('false' as const)
      : ('opaque' as const);

/** Private fixed RPC only: the owned original SDK reads immutable fixture scripts/first globals.
 * No arbitrary script, raw CDP endpoint, public runtime-mode admission or native proof DTO.
 */
export async function runFixtureOriginalChromeSupervisorWorker() {
  if (!process.send || !process.connected) throw new Error('CHROME_FIXTURE_PRIVATE_IPC_REQUIRED');
  const transmit = process.send.bind(process),
    disconnect = process.disconnect.bind(process);
  let owner: ReturnType<typeof createFixtureOriginalChromeSupervisor> | undefined;
  let context:
    | Awaited<ReturnType<ReturnType<typeof createFixtureOriginalChromeSupervisor>['open']>>
    | undefined;
  let accepted = false,
    stopped = false,
    lastSequence = 0,
    originalNonce: string | undefined,
    fixtureURL: string | undefined;
  let first:
    | Readonly<{ stage: 'launch' | 'sample' | 'send' | 'close' | 'protocol'; value: unknown }>
    | undefined;
  const originals = new Set<Promise<unknown>>();
  const admissionClosed = new Error('CHROME_FIXTURE_WORKER_CLOSED');
  let closing: Promise<void> | undefined;
  const note = (stage: NonNullable<typeof first>['stage'], value: unknown) => {
    if (value !== admissionClosed) first ??= { stage, value };
  };
  const guard = () => {
    if (stopped) throw admissionClosed;
  };
  const track = <T>(
    stage: NonNullable<typeof first>['stage'],
    producer: () => Promise<T>
  ): Promise<T> => {
    const original = Promise.resolve().then(producer);
    originals.add(original);
    void original.then(
      () => originals.delete(original),
      (value) => {
        note(stage, value);
        originals.delete(original);
      }
    );
    return original;
  };
  const send = (value: unknown) =>
    track('send', () => {
      if (!process.connected || Buffer.byteLength(JSON.stringify(value)) > 65536)
        return Promise.reject(new Error('CHROME_FIXTURE_REPLY_UNAVAILABLE'));
      return new Promise<void>((resolve, reject) => {
        try {
          transmit(value, (error) => (error == null ? resolve() : reject(error)));
        } catch (cause) {
          reject(cause);
        }
      });
    });
  const close = (): Promise<void> => {
    if (closing) return closing;
    stopped = true;
    closing = Promise.resolve().then(async () => {
      let result: Awaited<ReturnType<NonNullable<typeof owner>['close']>> | undefined;
      try {
        if (owner) result = await owner.close(5000);
      } catch (value) {
        note('close', value);
      }
      try {
        if (owner) await owner.joinOriginalShutdown();
      } catch (value) {
        note('close', value);
      }
      // Original owner stop has entered before the actual SDK/sampling/send joins.
      const joined = await Promise.allSettled([...originals]);
      for (const original of joined)
        if (original.status === 'rejected') note('close', original.reason);
      try {
        if (owner) result = await owner.close(0);
      } catch (value) {
        note('close', value);
      }
      const state =
        !first && result?.state === 'closed' && originals.size === 0 ? 'closed' : 'held';
      if (process.connected)
        try {
          await send({
            kind: 'closed',
            nonce: originalNonce,
            state,
            originalChildReturned: result?.originalChildReturned === true,
            descendantsReturned: result?.descendantsReturned === true,
            profileRemoved: result?.profileRemoved === true,
            identityAcknowledgementWithheld: result?.identityAcknowledgementWithheld === true,
            ...(result?.root ? { root: result.root } : {}),
            ...(first ? { failure: { stage: first.stage, kind: primitive(first.value) } } : {}),
            knownBaselineOriginals: result?.knownBaselineOriginals ?? [],
            candidateOriginals: result?.candidateOriginals ?? [],
            candidateCohortComplete: result?.candidateCohortComplete === true,
            candidate: 'UNVERIFIED',
          });
        } catch (value) {
          note('send', value);
        }
      process.exitCode = state === 'closed' && !first ? 0 : 1;
      if (process.connected)
        try {
          disconnect();
        } catch (value) {
          note('close', value);
          process.exitCode = 1;
        }
    });
    return closing;
  };
  const failed = async (stage: 'launch' | 'sample' | 'protocol', value: unknown) => {
    note(stage, value);
    if (!stopped && process.connected)
      try {
        await send({
          kind: 'failed',
          nonce: originalNonce,
          failure: { stage, kind: primitive(value) },
          candidate: 'UNVERIFIED',
        });
      } catch (cause) {
        note('send', cause);
      }
    await close();
  };
  process.once('disconnect', () => {
    void close().then(
      () => {},
      (value) => {
        note('close', value);
        process.exitCode = 1;
      }
    );
  });
  process.on('message', (message) => {
    if (stopped) return;
    try {
      if (Buffer.byteLength(JSON.stringify(message)) > 65536)
        throw new Error('CHROME_FIXTURE_COMMAND_EXCEEDED');
      if (!accepted) {
        const request = seed.parse(message);
        accepted = true;
        originalNonce = request.nonce;
        fixtureURL = request.fixtureURL;
        owner = createFixtureOriginalChromeSupervisor(request);
        const original = track('launch', async () => {
          guard();
          context = await owner!.open();
          guard();
          const baseline = owner!.nativeBaseline();
          guard();
          await send({
            kind: 'opened',
            nonce: originalNonce,
            baseline,
            baselineOriginals: owner!.baselineOriginals(),
            candidate: 'UNVERIFIED',
          });
        });
        void original.then(
          () => {},
          (value) => {
            void failed('launch', value).then(
              () => {},
              (cause) => {
                note('close', cause);
                process.exitCode = 1;
              }
            );
          }
        );
        return;
      }
      const request = action.parse(message);
      if (request.nonce !== originalNonce || request.sequence <= lastSequence)
        throw new Error('CHROME_FIXTURE_COMMAND_BINDING_CHANGED');
      lastSequence = request.sequence;
      if (request.kind === 'close') {
        void close().then(
          () => {},
          (value) => {
            note('close', value);
            process.exitCode = 1;
          }
        );
        return;
      }
      if (!owner || !context || originals.size)
        throw new Error('CHROME_FIXTURE_ORIGINAL_WORK_PENDING');
      const original = track('sample', async () => {
        guard();
        if (request.kind === 'sample-matrix') {
          const sample = owner!.sampleMatrix.bind(owner);
          guard();
          const observations = MatrixObservationsSchema.parse(await sample());
          guard();
          await send({
            kind: 'matrix-observation',
            nonce: originalNonce,
            sequence: request.sequence,
            observations,
            candidate: 'UNVERIFIED',
          });
          return;
        }
        const originalContext = context!,
          pages = originalContext.pages.bind(originalContext);
        guard();
        const page = pages()[0];
        guard();
        if (!page || page.context() !== originalContext)
          throw new Error('CHROME_FIXTURE_ORIGINAL_PAGE_CHANGED');
        const goto = page.goto.bind(page),
          evaluate = page.evaluate.bind(page);
        guard();
        await goto(fixtureURL!, { waitUntil: 'load', timeout: 10000 });
        guard();
        const observation = NativeIdentitySchema.parse(
          await evaluate(async () => {
            const nav = navigator as Navigator & {
              userAgentData?: {
                toJSON(): Record<string, unknown>;
                getHighEntropyValues(values: string[]): Promise<Record<string, unknown>>;
              };
            };
            const data = nav.userAgentData;
            return {
              userAgent: nav.userAgent,
              appVersion: nav.appVersion,
              platform: nav.platform,
              secureContext: self.isSecureContext,
              metadata: data
                ? {
                    ...data.toJSON(),
                    ...(await data.getHighEntropyValues([
                      'architecture',
                      'bitness',
                      'fullVersionList',
                      'model',
                      'platformVersion',
                      'uaFullVersion',
                      'wow64',
                      'formFactors',
                    ])),
                  }
                : null,
            };
          })
        );
        guard();
        await send({
          kind: 'page-observation',
          nonce: originalNonce,
          sequence: request.sequence,
          observation,
          candidate: 'UNVERIFIED',
        });
      });
      void original.then(
        () => {},
        (value) => {
          void failed('sample', value).then(
            () => {},
            (cause) => {
              note('close', cause);
              process.exitCode = 1;
            }
          );
        }
      );
    } catch (value) {
      void failed('protocol', value).then(
        () => {},
        (cause) => {
          note('close', cause);
          process.exitCode = 1;
        }
      );
    }
  });
}
