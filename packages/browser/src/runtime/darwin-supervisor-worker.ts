import { createSupervisorUncertaintyDiagnostic } from './supervisor-uncertainty-diagnostic.js';
import { TargetMetadataOwner } from './target-metadata.js';
import { createSemanticProcess } from '../semantic/process-owner.js';
import { runSemanticProcess } from '../semantic/process-worker.js';
// Private asset-module composition only; never exported from the browser application package.
export { SupervisedSemanticReader } from '../semantic/native-reader.js';
import { z } from 'zod';
import { sameProcess } from '../lifecycle/process-journal.js';
import { launchDarwinSupervisorBrowser } from './darwin-supervisor-browser.js';
import {
  SupervisorSeedSchema as seedSchema,
  SupervisorCommandSchema as requestSchema,
  SupervisorReplySchema,
  type SupervisorOriginalChild,
  SupervisorOriginalChildAcknowledgementSchema,
} from './darwin-supervisor-protocol.js';

/** Private bounded domain RPC. The supervisor retains actual context/child/proxy originals. */
export async function runDarwinSupervisorWorker(): Promise<void> {
  let owner: Awaited<ReturnType<typeof launchDarwinSupervisorBrowser>> | undefined;
  let launching: Promise<void> | undefined,
    stopping = false,
    accepted = false,
    lastSequence = 0;
  let seed: z.infer<typeof seedSchema>;
  let pending = 0,
    tail: Promise<void> = Promise.resolve(),
    closePromise: Promise<boolean> | undefined;
  let originalCloseSequence: number | undefined;
  const metadata = new TargetMetadataOwner();
  const semanticReaders = new Map<
    number,
    Promise<Awaited<ReturnType<typeof createSemanticProcess>>>
  >();
  let originalBirth: SupervisorOriginalChild | undefined;
  let birthResolve: (() => void) | undefined;
  let birthReject: ((value: unknown) => void) | undefined;
  let birthAcknowledged = false;

  const closeDiagnostic = createSupervisorUncertaintyDiagnostic();
  const pages = new Map<number, import('playwright-core').Page>();
  let nextTab = 1;
  const sends = new Set<Promise<void>>();
  const send = async (value: unknown) => {
    if (!process.connected || !process.send) return;
    const parsed = SupervisorReplySchema.parse(value);
    if (
      Buffer.byteLength(JSON.stringify(value)) > (parsed.kind === 'semanticReply' ? 266240 : 65536)
    )
      throw new Error('SUPERVISOR_REPLY_EXCEEDED');
    const original = new Promise<void>((resolve, reject) =>
      process.send!(parsed, (error) => (error ? reject(error) : resolve()))
    );
    sends.add(original);
    void original.then(
      () => sends.delete(original),
      () => {}
    );
    await original;
  };
  const close = (): Promise<boolean> => {
    stopping = true;
    birthReject?.(new Error('SUPERVISOR_STOPPED'));
    closePromise ??= (async () => {
      await launching?.catch(() => {});
      const results = await Promise.allSettled([
        owner ? owner.close() : Promise.resolve(false),
        tail,
        metadata.close(),
        ...[...semanticReaders.values()].map((reader) =>
          reader.then((original) => original.close())
        ),
      ]);
      pages.clear();
      semanticReaders.clear();
      const returned =
        results.every((result) => result.status === 'fulfilled') &&
        results[0]?.status === 'fulfilled' &&
        results[0].value === true &&
        sends.size === 0;
      if (!returned) {
        const rejected = results.findIndex((result) => result.status === 'rejected');
        if (rejected === 0) closeDiagnostic.note('WORKER_OWNER_REJECT');
        else if (rejected === 1) closeDiagnostic.note('WORKER_TAIL_REJECT');
        else if (rejected === 2) closeDiagnostic.note('WORKER_METADATA_REJECT');
        else if (rejected > 2) closeDiagnostic.note('WORKER_SEMANTIC_REJECT');
        else if (results[0]?.status === 'fulfilled' && results[0].value !== true)
          closeDiagnostic.note('WORKER_OWNER_FALSE');
        else closeDiagnostic.note('WORKER_SENDS_PENDING');
        closeDiagnostic.emit();
      }
      return returned;
    })();
    return closePromise;
  };
  const disconnect = () => {
    void close().then(
      (returned) => {
        process.exitCode = returned ? 0 : 1;
        if (process.connected) process.disconnect();
      },
      () => {
        process.exitCode = 1;
        if (process.connected) process.disconnect();
      }
    );
  };
  process.once('disconnect', disconnect);
  process.on('message', (message) => {
    if (stopping) return;
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(message));
    } catch {
      disconnect();
      return;
    }
    if (bytes > 65536) {
      disconnect();
      return;
    }
    if (!accepted) {
      accepted = true;
      const parsed = seedSchema.safeParse(message);
      if (!parsed.success) {
        disconnect();
        return;
      }
      seed = parsed.data;
      if (seed.manager.pid !== process.ppid) {
        disconnect();
        return;
      }
      const origin = new URL(seed.origin);
      if (
        !seed.ownedProxy &&
        (origin.protocol !== 'http:' ||
          !['127.0.0.1', '[::1]'].includes(origin.hostname) ||
          origin.origin !== seed.origin ||
          !origin.port)
      ) {
        disconnect();
        return;
      }
      launching = (async () => {
        owner = await launchDarwinSupervisorBrowser(
          seed,
          (cause, root) => {
            void send(
              cause === 'browser' && root
                ? { kind: 'rootFailure', nonce: seed!.nonce, root }
                : { kind: 'custodyFault', nonce: seed!.nonce }
            ).catch(() => {});
            disconnect();
          },
          async (root) => {
            // This callback can enter only after the original Chromium child returned.
            // Disconnect-driven cleanup does not manufacture a command correlation.
            if (originalCloseSequence === undefined) return;
            await send({
              kind: 'rootReturned',
              nonce: seed.nonce,
              sequence: originalCloseSequence,
              root,
            });
          },
          seed.observeOriginalChild
            ? async (original) => {
                if (stopping || originalBirth) throw new Error('SUPERVISOR_STOPPED');
                originalBirth = original;
                const acknowledgement = new Promise<void>((resolve, reject) => {
                  birthResolve = resolve;
                  birthReject = reject;
                });
                void acknowledgement.catch(() => {});
                await Promise.all([
                  send({
                    kind: 'originalChild',
                    nonce: seed.nonce,
                    reservationNonce: seed.reservationNonce,
                    browserId: seed.browserId,
                    generation: seed.generation,
                    original,
                  }),
                  acknowledgement,
                ]);
                if (stopping || !birthAcknowledged) throw new Error('SUPERVISOR_STOPPED');
              }
            : undefined,
          async (identities) => {
            // Observation subjects only; the controller independently checks original deaths.
            await send({ kind: 'nativeBaselineObserved', nonce: seed.nonce, identities });
          },
          () => !stopping
        );
        if (stopping) return;
        // Acquisition settles independently of the original IPC acknowledgement.
        void send({
          kind: 'ready',
          nonce: seed.nonce,
          browserId: seed.browserId,
          reservationNonce: seed.reservationNonce,
          generation: seed.generation,
          endpointURL: owner.endpointURL,
          root: owner.root,
          supervisor: owner.supervisor,
          proxyURL: owner.proxyURL,
        }).catch(() => disconnect());
      })();
      void launching.catch(() => disconnect());
      return;
    }
    if (
      message &&
      typeof message === 'object' &&
      'kind' in message &&
      message.kind === 'originalChildObserved'
    ) {
      const ack = SupervisorOriginalChildAcknowledgementSchema.safeParse(message);
      if (
        !ack.success ||
        !seed.observeOriginalChild ||
        !originalBirth ||
        birthAcknowledged ||
        ack.data.nonce !== seed.nonce ||
        ack.data.reservationNonce !== seed.reservationNonce ||
        ack.data.browserId !== seed.browserId ||
        ack.data.generation !== seed.generation ||
        !sameProcess(ack.data.original.root, originalBirth.root) ||
        !sameProcess(ack.data.original.supervisor, originalBirth.supervisor) ||
        !sameProcess(ack.data.original.manager, seed.manager) ||
        ack.data.original.complete !== originalBirth.complete ||
        ack.data.original.identities.length !== originalBirth.identities.length ||
        !ack.data.original.identities.every((identity, index) =>
          sameProcess(identity, originalBirth!.identities[index]!)
        )
      ) {
        disconnect();
        return;
      }
      birthAcknowledged = true;
      birthResolve?.();
      return;
    }
    const parsed = requestSchema.safeParse(message);
    if (
      !parsed.success ||
      parsed.data.nonce !== seed.nonce ||
      parsed.data.sequence !== lastSequence + 1 ||
      pending >= 8
    ) {
      disconnect();
      return;
    }
    const request = parsed.data;
    lastSequence = request.sequence;
    if (request.action.kind === 'close') {
      originalCloseSequence = request.sequence;
      void close()
        .then(async (returned) => {
          await send({
            kind: 'closed',
            nonce: seed.nonce,
            sequence: request.sequence,
            returned,
          });
          if (process.connected) process.disconnect();
          process.exitCode = returned ? 0 : 1;
        })
        .catch(disconnect);
      return;
    }
    pending++;
    const operation = tail.then(async () => {
      await launching;
      if (stopping || !owner) throw new Error('SUPERVISOR_STOPPED');
      metadata.assertCurrent();
      if (
        request.action.kind === 'semanticRead' ||
        request.action.kind === 'semanticResolve' ||
        request.action.kind === 'semanticTarget' ||
        request.action.kind === 'semanticChanges' ||
        request.action.kind === 'semanticBeginEdit' ||
        request.action.kind === 'semanticEditPhase' ||
        request.action.kind === 'semanticFinishEdit'
      ) {
        const action = request.action,
          page = pages.get(action.tab);
        if (!page || page.isClosed()) throw new Error('SUPERVISOR_TARGET_REFUSED');
        let original = semanticReaders.get(action.tab);
        if (!original) {
          if (semanticReaders.size >= 8) throw new Error('SUPERVISOR_SEMANTIC_CAPACITY');
          let accept!: (value: Awaited<ReturnType<typeof createSemanticProcess>>) => void,
            reject!: (reason: unknown) => void;
          original = new Promise((a, b) => {
            accept = a;
            reject = b;
          });
          semanticReaders.set(action.tab, original);
          void original.catch(() => {});
          void Promise.resolve()
            .then(async () => {
              if (stopping || !owner || page.isClosed())
                throw new Error('SUPERVISOR_TARGET_REFUSED');
              const { targetId: target } = await metadata.read(
                page,
                () => !stopping && !!owner && pages.get(action.tab) === page
              );
              if (stopping || !owner || page.isClosed())
                throw new Error('SUPERVISOR_TARGET_REFUSED');
              const created = await createSemanticProcess(owner.endpointURL, target);
              if (stopping) {
                await created.close();
                throw new Error('SUPERVISOR_STOPPED');
              }
              return created;
            })
            .then(accept, reject);
        }
        const reader = await original;
        if (stopping || page.isClosed()) throw new Error('SUPERVISOR_TARGET_REFUSED');
        if (action.kind === 'semanticRead') {
          if (
            action.identity.browserId !== seed.browserId ||
            action.identity.browserGeneration !== seed.generation
          )
            throw new Error('SUPERVISOR_TARGET_REFUSED');
          const snapshot = await reader.read(action.identity, action.actorKey, action.grantKey);
          if (!stopping)
            await send({
              kind: 'semanticReply',
              nonce: seed.nonce,
              sequence: request.sequence,
              snapshot,
            });
        } else if (action.kind === 'semanticBeginEdit') {
          const target = await reader.beginEdit(
            action.requestId,
            action.leaseId,
            action.nodeRef,
            action.actorKey,
            action.grantKey
          );
          if (!stopping)
            await send({
              kind: 'semanticEditBegun',
              nonce: seed.nonce,
              sequence: request.sequence,
              target,
            });
        } else if (action.kind === 'semanticEditPhase') {
          await reader.editPhase(action.requestId, action.actorKey, action.grantKey, action.phase);
          if (!stopping)
            await send({
              kind: 'semanticEditStepped',
              nonce: seed.nonce,
              sequence: request.sequence,
            });
        } else if (action.kind === 'semanticFinishEdit') {
          const result = await reader.finishEdit(
            action.requestId,
            action.actorKey,
            action.grantKey
          );
          if (!stopping)
            await send({
              kind: 'semanticEditFinished',
              nonce: seed.nonce,
              sequence: request.sequence,
              result,
            });
        } else if (action.kind === 'semanticTarget') {
          const target = await reader.target(
            action.leaseId,
            action.nodeRef,
            action.actorKey,
            action.grantKey
          );
          if (!stopping)
            await send({
              kind: 'semanticTargeted',
              nonce: seed.nonce,
              sequence: request.sequence,
              target,
            });
        } else if (action.kind === 'semanticChanges') {
          const changes = await reader.changes(action.actorKey, action.grantKey);
          if (!stopping)
            await send({
              kind: 'semanticChanged',
              nonce: seed.nonce,
              sequence: request.sequence,
              changes,
            });
        } else {
          const current = await reader.resolve(
            action.leaseId,
            action.nodeRef,
            action.actorKey,
            action.grantKey
          );
          if (!stopping)
            await send({
              kind: 'semanticResolved',
              nonce: seed.nonce,
              sequence: request.sequence,
              current,
            });
        }
        return;
      }
      let value: unknown;
      if (request.action.kind === 'list') {
        const nativePages = metadata.pages(() => owner!.context.pages());
        metadata.observe(() => {
          if (pages.size > 64) throw new Error('SUPERVISOR_TAB_LIMIT');
        });
        for (const page of nativePages) {
          if (![...pages.values()].includes(page)) {
            metadata.observe(() => {
              if (pages.size >= 64) throw new Error('SUPERVISOR_TAB_LIMIT');
            });
            pages.set(nextTab++, page);
          }
        }
        const rows: { tab: number; url: string; targetId: string }[] = [];
        const targets = new Set<string>();
        for (const [tab, page] of pages) {
          if (metadata.observe(() => page.isClosed())) continue;
          const row = await metadata.read(page, () => !stopping && pages.get(tab) === page);
          metadata.observe(() => {
            if (targets.has(row.targetId)) throw new Error('SUPERVISOR_TARGET_REFUSED');
          });
          targets.add(row.targetId);
          rows.push({ tab, ...row });
        }
        value = rows;
      } else if (request.action.kind === 'navigate') {
        const page = pages.get(request.action.tab),
          url = new URL(request.action.url);
        if (
          !page ||
          page.isClosed() ||
          !['http:', 'https:'].includes(url.protocol) ||
          (!seed.ownedProxy && url.origin !== seed.origin) ||
          url.username ||
          url.password
        )
          throw new Error('SUPERVISOR_TARGET_REFUSED');
        await page.goto(url.href, { timeout: 5000 });
        value = { tab: request.action.tab };
      } else throw new Error('SUPERVISOR_ACTION_REFUSED');
      if (!stopping)
        await send({
          kind: 'reply',
          nonce: seed.nonce,
          sequence: request.sequence,
          value,
        });
    });
    tail = operation
      .catch(async (error: unknown) => {
        process.stderr.write(
          (request.action.kind === 'semanticRead' ||
          request.action.kind === 'semanticResolve' ||
          request.action.kind === 'semanticTarget' ||
          request.action.kind === 'semanticChanges' ||
          request.action.kind === 'semanticBeginEdit' ||
          request.action.kind === 'semanticEditPhase' ||
          request.action.kind === 'semanticFinishEdit'
            ? 'SUPERVISOR_SEMANTIC_REFUSED'
            : error instanceof Error
              ? error.message.slice(0, 1024)
              : 'SUPERVISOR_ACTION_FAILED') + '\n'
        );
        if (!stopping)
          await send({
            kind: 'refused',
            nonce: seed.nonce,
            sequence: request.sequence,
          });
      })
      .then(() => {
        pending--;
      });
    void tail.catch(disconnect);
  });
}
if (process.argv[2] === '--private-darwin-browser-supervisor') void runDarwinSupervisorWorker();
if (process.argv[2] === '--private-semantic-worker')
  void runSemanticProcess().catch(() => {
    process.exitCode = 1;
  });
