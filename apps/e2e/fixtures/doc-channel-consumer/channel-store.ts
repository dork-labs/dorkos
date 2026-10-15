import { constructOriginalConsumerInitial } from './channel-store/channel-store-initial.js';
import { constructOriginalConsumerIdentity } from './channel-store/channel-store-identity.js';
import { constructOriginalConsumerRoom } from './channel-store/channel-store-room.js';
import { constructOriginalConsumerDocument } from './channel-store/channel-store-document.js';
import { constructOriginalConsumerRuntime } from './channel-store/channel-store-runtime.js';
import { constructOriginalConsumerControls } from './channel-store/channel-store-controls.js';
import { createOriginalConsumerReviewedControls } from './channel-store/channel-store-reviewed-controls.js';
import { createOriginalConsumerCanonicalControls } from './channel-store/channel-store-canonical-controls.js';
import { createOriginalConsumerPresenceControls } from './channel-store/channel-store-presence-controls.js';
import { createOriginalConsumerSavedControls } from './channel-store/channel-store-saved-controls.js';
import { createOriginalConsumerSelectionControls } from './channel-store/channel-store-selection-controls.js';
import { createOriginalConsumerCheckboxControls } from './channel-store/channel-store-checkbox-controls.js';
import { createOriginalConsumerMcpControls } from './channel-store/channel-store-mcp-controls.js';
import { createOriginalConsumerWidgetControls } from './channel-store/channel-store-widget-controls.js';
import { createOriginalConsumerCommonControls } from './channel-store/channel-store-common-controls.js';
import { failOriginalConsumerConstruction } from './channel-store/channel-store-failure.js';
/** Real protected-source fixture composition. No browser/page can select an actor or issuer. */
import { type NativeEmissionIntegrityCase } from './native-emission-integrity-control.js';

import { type ConsumerVault, type WriterOperation } from './writer.js';

type PublishedRetirementControls = Pick<
  ReturnType<typeof createOriginalConsumerReviewedControls>,
  'stopOriginalReviewedReplay'
> &
  Pick<ReturnType<typeof createOriginalConsumerPresenceControls>, 'stopOriginalSavedDispatch'> &
  Pick<ReturnType<typeof createOriginalConsumerSelectionControls>, 'stopOriginalSelectionDispatch'>;
const publishedOwners = new WeakMap<object, PublishedRetirementControls>();
/** Only the constructor key selects its final actual published retirement receiver. */
export function requireOriginalConsumerPublished(key: object): PublishedRetirementControls {
  const context = phaseApply(phaseGet, publishedOwners, [key]) as
    PublishedRetirementControls | undefined;
  if (!context) throw new Error('Original published consumer owner required');
  return context;
}
const phaseGet = WeakMap.prototype.get;
const phaseSet = WeakMap.prototype.set;
const phaseApply = Reflect.apply;
interface ConsumerInput {
  vault: ConsumerVault;
  dashboardUrl: string;
  hostBootstrap: boolean;
  target: 'session' | 'room';
  integrityCase: NativeEmissionIntegrityCase;
  resume?: NativeConsumerResume;
  frameMode: 'routed' | 'log-only';
}
const inputOwners = new WeakMap<object, ConsumerInput>();
/** Lookup only the exact inaccessible original construction key. */
export function requireOriginalConsumerInput(key: object): ConsumerInput {
  const context = phaseApply(phaseGet, inputOwners, [key]) as ConsumerInput | undefined;
  if (!context) throw new Error('Original consumer input owner required');
  return context;
}
const initialOwners = new WeakMap<
  object,
  Awaited<ReturnType<typeof constructOriginalConsumerInitial>>
>();
/** Lookup only the exact inaccessible original construction key. */
export function requireOriginalConsumerInitial(
  key: object
): Awaited<ReturnType<typeof constructOriginalConsumerInitial>> {
  const context = phaseApply(phaseGet, initialOwners, [key]) as
    Awaited<ReturnType<typeof constructOriginalConsumerInitial>> | undefined;
  if (!context) throw new Error('Original consumer initial owner required');
  return context;
}
const identityOwners = new WeakMap<
  object,
  Awaited<ReturnType<typeof constructOriginalConsumerIdentity>>
>();
/** Lookup only the exact inaccessible original construction key. */
export function requireOriginalConsumerIdentity(
  key: object
): Awaited<ReturnType<typeof constructOriginalConsumerIdentity>> {
  const context = phaseApply(phaseGet, identityOwners, [key]) as
    Awaited<ReturnType<typeof constructOriginalConsumerIdentity>> | undefined;
  if (!context) throw new Error('Original consumer identity owner required');
  return context;
}
const roomOwners = new WeakMap<object, Awaited<ReturnType<typeof constructOriginalConsumerRoom>>>();
/** Lookup only the exact inaccessible original construction key. */
export function requireOriginalConsumerRoom(
  key: object
): Awaited<ReturnType<typeof constructOriginalConsumerRoom>> {
  const context = phaseApply(phaseGet, roomOwners, [key]) as
    Awaited<ReturnType<typeof constructOriginalConsumerRoom>> | undefined;
  if (!context) throw new Error('Original consumer room owner required');
  return context;
}
const documentOwners = new WeakMap<
  object,
  Awaited<ReturnType<typeof constructOriginalConsumerDocument>>
>();
/** Lookup only the exact inaccessible original construction key. */
export function requireOriginalConsumerDocument(
  key: object
): Awaited<ReturnType<typeof constructOriginalConsumerDocument>> {
  const context = phaseApply(phaseGet, documentOwners, [key]) as
    Awaited<ReturnType<typeof constructOriginalConsumerDocument>> | undefined;
  if (!context) throw new Error('Original consumer document owner required');
  return context;
}
const runtimeOwners = new WeakMap<
  object,
  Awaited<ReturnType<typeof constructOriginalConsumerRuntime>>
>();
/** Lookup only the exact inaccessible original construction key. */
export function requireOriginalConsumerRuntime(
  key: object
): Awaited<ReturnType<typeof constructOriginalConsumerRuntime>> {
  const context = phaseApply(phaseGet, runtimeOwners, [key]) as
    Awaited<ReturnType<typeof constructOriginalConsumerRuntime>> | undefined;
  if (!context) throw new Error('Original consumer runtime owner required');
  return context;
}
const controlsOwners = new WeakMap<
  object,
  Awaited<ReturnType<typeof constructOriginalConsumerControls>>
>();
/** Lookup only the exact inaccessible original construction key. */
export function requireOriginalConsumerControls(
  key: object
): Awaited<ReturnType<typeof constructOriginalConsumerControls>> {
  const context = phaseApply(phaseGet, controlsOwners, [key]) as
    Awaited<ReturnType<typeof constructOriginalConsumerControls>> | undefined;
  if (!context) throw new Error('Original consumer controls owner required');
  return context;
}
/** The legacy writer adapter delegates to one actual installed native owner. */
export class ConsumerChannelStore {
  private restart?: Promise<void>;
  private retirement?: Promise<void>;
  private constructor(private owner: Awaited<ReturnType<typeof openNativeConsumerStore>>) {}
  static async open(vault: ConsumerVault, dashboardUrl: string) {
    return new ConsumerChannelStore(await openNativeConsumerStore(vault, dashboardUrl));
  }
  get file() {
    return this.owner.file;
  }
  get documentId() {
    return this.owner.documentId;
  }
  emit(raw: unknown) {
    if (this.retirement) throw new Error('Native consumer retired');
    return this.owner.emit(raw);
  }
  confirm(op: WriterOperation) {
    return this.owner.confirm(op);
  }
  async receipt(id: string) {
    const inspected = await this.owner.inspect(id);
    if (inspected.kind !== 'receipt') throw new Error('Original receipt unavailable');
    return inspected.event;
  }
  replay() {
    return this.owner.replay();
  }
  admit() {
    return this.owner.admit();
  }
  restartCanonical() {
    if (this.retirement) throw new Error('Native consumer retired');
    if (this.restart) return this.restart;
    this.restart = Promise.resolve().then(async () => {
      await this.owner.movePrivateCanonical();
      await this.owner.close();
      this.owner = await reopenNativeConsumerStore(this.owner);
    });
    return this.restart;
  }
  close() {
    if (this.retirement) return this.retirement;
    this.retirement = Promise.resolve().then(async () => {
      let failed = false,
        first: unknown;
      const remember = (cause: unknown) => {
        if (!failed) {
          failed = true;
          first = cause;
        }
      };
      try {
        await this.restart;
      } catch (cause) {
        remember(cause);
      }
      try {
        await this.owner.close();
      } catch (cause) {
        remember(cause);
      }
      if (failed) throw first;
    });
    return this.retirement;
  }
}

export interface NativeConsumerResume {
  owner: object | undefined;
  closed: boolean;
  used: boolean;
  vault: ConsumerVault;
  dashboardUrl: string;
  installationId: string;
  agentId: string;
  sessionId: string;
  documentId: string;
  roomId: string | undefined;
  authorId: string;
  roomAgentAuthorId: string | undefined;
  scope: string;
  grantId?: string;
  birthJson: string;
}
const originalNativeConsumerResumes = new WeakMap<object, NativeConsumerResume>();
const originalNativeConsumerResumeArguments = new WeakSet<NativeConsumerResume>();
/** Fixed same-vault fresh constructor. Only the positively closed original factory child can select its resume record. */
export async function reopenNativeConsumerStore(original: object) {
  const own = originalNativeConsumerResumes.get(original);
  if (
    !own ||
    own.owner !== original ||
    !own.closed ||
    !own.grantId ||
    own.used ||
    (own.roomId !== undefined && !own.roomAgentAuthorId)
  )
    throw new Error('Original positively closed native Room fixture required');
  own.used = true;
  return openNativeConsumerStore(
    own.vault,
    own.dashboardUrl,
    own.roomId !== undefined,
    own.roomId ? 'room' : 'session',
    'none',
    own
  );
}

/** Genuine FILE/native/Room construction, independent of Vitest's suite or vi imports.
 * The isolated host uses the production paid-safe TestMode constructor. Actual
 * Room COMMIT/FIRST, cancellation and restart require their original owner ports.
 */
export async function openNativeConsumerStore(
  vault: ConsumerVault,
  dashboardUrl: string,
  hostBootstrap = false,
  target: 'session' | 'room' = 'session',
  integrityCase: NativeEmissionIntegrityCase = 'none',
  resume?: NativeConsumerResume,
  frameMode: 'routed' | 'log-only' = 'routed'
) {
  if (
    !['routed', 'log-only'].includes(frameMode) ||
    (frameMode === 'log-only' &&
      (!hostBootstrap || target !== 'session' || integrityCase !== 'none' || resume))
  )
    throw new Error('Finite original frame declaration mode required');
  if (
    resume &&
    (!originalNativeConsumerResumeArguments.has(resume) ||
      !resume.closed ||
      !resume.used ||
      !resume.grantId ||
      hostBootstrap !== (resume.roomId !== undefined) ||
      target !== (resume.roomId ? 'room' : 'session') ||
      integrityCase !== 'none')
  )
    throw new Error('Foreign native fixture resume');
  if (
    !['none', 'select-builder', 'event-codec'].includes(integrityCase) ||
    (integrityCase !== 'none' && (!hostBootstrap || target !== 'room'))
  )
    throw new Error('Finite original native Room integrity case required');
  const ownerKey = Object.freeze({});
  phaseApply(phaseSet, inputOwners, [
    ownerKey,
    {
      vault,
      dashboardUrl,
      hostBootstrap,
      target,
      integrityCase,
      resume,
      frameMode,
    } satisfies ConsumerInput,
  ]);
  const initialContext = await constructOriginalConsumerInitial(ownerKey);
  phaseApply(phaseSet, initialOwners, [ownerKey, initialContext]);
  try {
    phaseApply(phaseSet, identityOwners, [
      ownerKey,
      await constructOriginalConsumerIdentity(ownerKey),
    ]);
    phaseApply(phaseSet, roomOwners, [ownerKey, await constructOriginalConsumerRoom(ownerKey)]);
    phaseApply(phaseSet, documentOwners, [
      ownerKey,
      await constructOriginalConsumerDocument(ownerKey),
    ]);
    phaseApply(phaseSet, runtimeOwners, [
      ownerKey,
      await constructOriginalConsumerRuntime(ownerKey),
    ]);
    phaseApply(phaseSet, controlsOwners, [
      ownerKey,
      await constructOriginalConsumerControls(ownerKey),
    ]);
    const published = {
      ...createOriginalConsumerReviewedControls(ownerKey),
      ...createOriginalConsumerCanonicalControls(ownerKey),
      ...createOriginalConsumerPresenceControls(ownerKey),
      ...createOriginalConsumerSavedControls(ownerKey),
      ...createOriginalConsumerSelectionControls(ownerKey),
      ...createOriginalConsumerCheckboxControls(ownerKey),
      ...createOriginalConsumerMcpControls(ownerKey),
      ...createOriginalConsumerWidgetControls(ownerKey),
      ...createOriginalConsumerCommonControls(ownerKey),
    };
    phaseApply(phaseSet, publishedOwners, [ownerKey, published]);
    const { resumeRecord } = requireOriginalConsumerControls(ownerKey);
    resumeRecord.owner = published;
    originalNativeConsumerResumeArguments.add(resumeRecord);
    originalNativeConsumerResumes.set(published, resumeRecord);
    return published;
  } catch (cause) {
    await failOriginalConsumerConstruction(ownerKey, cause);
    throw cause;
  }
}
