/** Frame/load/resource custody only; genuine original subject stays in core. */
import {
  FrameLifetimeController,
  createBoundDocPort,
  type FrameObservation,
  type BoundDocPort,
} from '@/layers/shared/lib/canvas-doc-frame';
import {
  sameCanvasDocIncarnation,
  type CanvasDocIncarnation,
} from '@dorkos/shared/canvas-doc-frame-wire';
import { DocChannelFrameResources } from './doc-channel-frame-resources';
import { prepareDocFrameLoad, attachDocFramePort } from './doc-channel-frame-admission';
import { captureBoundOriginal, createDocChannelNativePorts } from './doc-channel-native-ports';
import {
  readRecordSubject,
  readRecordNativeOperations,
  readRecordFrameOperations,
} from './doc-channel-owner-record';
import type { DocChannelBinding } from './doc-channel-view';
import {
  requireOwnedCustody,
  readOwnedFacts,
  readOwnedTransport,
  captureOwnedSubject,
  readOwnedSubject,
  ownedSubjectCurrent,
} from './doc-channel-owner-custody';
const acquireBinding = FrameLifetimeController.prototype.acquireDoc;
const entries = new WeakMap<
  object,
  { frames: DocChannelFrameResources; facade: ReturnType<typeof buildFacade> }
>();
const retirements = new WeakMap<
  object,
  { owner: object; frames: DocChannelFrameResources; ticket: object }
>();

function buildFacade(custodyKey: object, frames: DocChannelFrameResources) {
  const transportOwner = readOwnedTransport(custodyKey);
  const loadedBirths = new WeakMap<
    FrameObservation,
    { record: object; birth: CanvasDocIncarnation }
  >();
  const frameCurrent = (record: object, ticket: number) =>
    frames.current(ticket) && ownedSubjectCurrent(custodyKey, record);
  const frameAdmission = Object.freeze({
    prepareFrameLoad: (controller: FrameLifetimeController, observation: FrameObservation) => {
      if (!(controller instanceof FrameLifetimeController) || observation.loaded) return null;
      const record = captureOwnedSubject(custodyKey),
        baseline = record ? readOwnedSubject(custodyKey, record)?.httpBaseline : undefined;
      const ticket = frames.begin();
      if (
        !record ||
        !baseline ||
        !frames.current(ticket) ||
        !ownedSubjectCurrent(custodyKey, record) ||
        controller.getCurrent() !== observation ||
        observation.transportOwner !== transportOwner ||
        !frameCurrent(record, ticket)
      )
        return null;
      // Capture BEFORE real navigation; the actual onLoad consumes this exact context.
      let completedObservation: FrameObservation | null = null;
      return prepareDocFrameLoad(frames, ticket, {
        current: () =>
          ownedSubjectCurrent(custodyKey, record) &&
          readOwnedSubject(custodyKey, record)?.httpBaseline === baseline &&
          controller.getCurrent() === (completedObservation ?? observation) &&
          frames.current(ticket) &&
          ownedSubjectCurrent(custodyKey, record),
        complete: () => {
          completedObservation = controller.observeLoaded(observation);
          return completedObservation;
        },
        accept: (loaded) => {
          if (
            !frames.current(ticket) ||
            !ownedSubjectCurrent(custodyKey, record) ||
            readOwnedSubject(custodyKey, record)?.httpBaseline !== baseline ||
            controller.getCurrent() !== loaded ||
            !frames.current(ticket) ||
            !ownedSubjectCurrent(custodyKey, record) ||
            readOwnedSubject(custodyKey, record)?.httpBaseline !== baseline
          )
            return false;
          loadedBirths.set(loaded, { record, birth: baseline.birth });
          return true;
        },
      });
    },
    // A quarantined record cannot issue actions. This predicate retains only passive
    // custody of the exact completed load; attachFrame still requires fresh qualification.
    retainsLoadedFrame: (controller: FrameLifetimeController, observation: FrameObservation) => {
      if (!(controller instanceof FrameLifetimeController) || !observation.loaded) return false;
      const previous = loadedBirths.get(observation);
      const record = captureOwnedSubject(custodyKey);
      const subject = record && readOwnedSubject(custodyKey, record);
      return (
        !!previous &&
        !!record &&
        !!subject &&
        readOwnedFacts(custodyKey).live &&
        previous.record === record &&
        sameCanvasDocIncarnation(previous.birth, subject.birth) &&
        readOwnedTransport(custodyKey) === transportOwner &&
        observation.transportOwner === transportOwner &&
        controller.getCurrent() === observation
      );
    },
    subscribeInvalidation: (callback: () => void) => frames.subscribe(callback),
    attachFrame: (
      controller: FrameLifetimeController,
      observation: FrameObservation
    ): BoundDocPort | null => {
      if (!(controller instanceof FrameLifetimeController)) return null;
      const record = captureOwnedSubject(custodyKey);
      const ticket = frames.begin();
      if (
        !record ||
        !frames.current(ticket) ||
        !ownedSubjectCurrent(custodyKey, record) ||
        controller.getCurrent() !== observation ||
        observation.transportOwner !== transportOwner ||
        !frameCurrent(record, ticket)
      )
        return null;
      const previous = loadedBirths.get(observation);
      if (
        !previous ||
        previous.record !== record ||
        !sameCanvasDocIncarnation(previous.birth, readOwnedSubject(custodyKey, record)!.birth)
      )
        return null;
      return attachDocFramePort(frames, ticket, {
        current: () => frameCurrent(record, ticket),
        acquire: () => {
          // Genuine shared issuer returns only its own captured claim, never a nested winner.
          const acquisition = acquireBinding.call(
            controller,
            observation,
            readOwnedSubject(custodyKey, record)!.birth,
            readOwnedSubject(custodyKey, record)!.birth.documentId
          );
          let delivered = false;
          let result: typeof acquisition | null = null;
          let failure: { cause: unknown } | undefined;
          try {
            if (
              frameCurrent(record, ticket) &&
              controller.getCurrent() === observation &&
              frameCurrent(record, ticket)
            ) {
              result = Object.freeze({
                binding: acquisition.binding,
                release: acquisition.release,
              });
              delivered = true;
            }
          } catch (cause) {
            failure = { cause };
          }
          if (!delivered) {
            try {
              acquisition.release();
            } catch (cleanupCause) {
              failure ??= { cause: cleanupCause };
            }
          }
          if (failure) throw failure.cause;
          return result;
        },
        bindingCurrent: (binding) => controller.isCurrent(binding) && frameCurrent(record, ticket),
        createPort: (binding) =>
          createBoundDocPort(controller, binding, {
            owner: transportOwner,
            publisherEpoch: observation.publisherEpoch,
            isCurrentOwner: (candidateTransportOwner, epoch) =>
              candidateTransportOwner === transportOwner &&
              epoch === observation.publisherEpoch &&
              frames.current(ticket) &&
              ownedSubjectCurrent(custodyKey, record),
            captureOriginal: (request) =>
              captureBoundOriginal(
                request,
                (event) => {
                  const operations = readRecordFrameOperations(custodyKey, record);
                  return operations
                    ? createDocChannelNativePorts(operations).captureOriginal(event)
                    : null;
                },
                () => frameCurrent(record, ticket)
              ),
            submit: async () => ({ kind: 'terminal' }),
            inspect: async () => ({ kind: 'unknown' }),
          }),
        portCurrent: (port) => port.current() && frameCurrent(record, ticket),
      });
    },
  });
  return frameAdmission;
}
/** Create the nonissuing frame facade for this genuine custody owner. */
export function createOwnedFrameFacade(owner: object) {
  requireOwnedCustody(owner);
  if (entries.has(owner)) throw new Error('Frame owner is already initialized.');
  const frames = new DocChannelFrameResources();
  const facade = buildFacade(owner, frames);
  entries.set(owner, { frames, facade });
  return facade;
}
/** Read only the frame facade installed by this genuine owner’s constructor. */
export function readOwnedFrameFacade(owner: object) {
  requireOwnedCustody(owner);
  return entries.get(owner)?.facade;
}
/** Capture exact OLD cleanup without callbacks, before core revokes the original subject. */
export function captureOwnedFrameRetirement(owner: object): object | undefined {
  requireOwnedCustody(owner);
  const entry = entries.get(owner);
  if (!entry) return undefined;
  const key = Object.freeze({});
  retirements.set(key, { owner, frames: entry.frames, ticket: entry.frames.captureRetirement() });
  return key;
}
/** Reduction only: this captured ticket can never attach/send or choose a nested winner. */
export function consumeOwnedFrameRetirement(owner: object, key: object | undefined): void {
  if (!key) return;
  const entry = retirements.get(key);
  if (!entry || entry.owner !== owner) throw new Error('Frame retirement is foreign or consumed.');
  retirements.delete(key);
  entry.frames.drainRetirement(entry.ticket);
}

/** Assembly only: the record kernel alone issues and checks the original subject. */
export function readOwnedNativeBinding(
  custodyKey: object,
  subject: object
): DocChannelBinding | undefined {
  const record = readRecordSubject(custodyKey, subject);
  const operations = readRecordNativeOperations(custodyKey, subject);
  if (!record || !operations) return undefined;
  return { owner: subject, verified: record.verified, ...createDocChannelNativePorts(operations) };
}
