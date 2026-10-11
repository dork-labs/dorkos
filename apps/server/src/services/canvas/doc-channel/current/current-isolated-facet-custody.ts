import type { OriginalRoomRetirementFacet } from './room/current-room-retirement-context.js';
import type { OriginalDocumentCaptureFacet } from './projection/current-document-capture-context.js';
import type { OriginalRoomProducerFacet } from './room/current-room-producer-context.js';
import type { OriginalCurrentEntryFacet } from './projection/current-entry-context.js';
import type { OriginalEditorSaveSelectionFacet } from './projection/current-editor-save-selection-context.js';
import type { OriginalTokenNativeInputFacet } from './token/current-token-native-input-context.js';
import type { OriginalTokenIssuanceFacet } from './token/current-token-issuance-context.js';
import type { OriginalMountedPresenceFacet } from './presence/current-mounted-presence-context.js';
import type { OriginalEventAdmissionFacet } from './projection/current-event-admission-context.js';
import type { OriginalPresenceExpiryFacet } from './presence/current-presence-expiry-context.js';
import type { OriginalReadProjectionFacet } from './projection/current-read-projection-context.js';
import type { OriginalExpiredReplayFacet } from './replay/current-expired-replay-context.js';
import type { OriginalTokenStreamFacet } from './token/current-token-stream-facet.js';

/** Each invocation owns unrelated maps; only the original private engine module retains its actual registrar closures. */
export function createIsolatedEngineFacetCustody(
  originalFacetApply: typeof Reflect.apply,
  originalFacetGet: typeof WeakMap.prototype.get,
  originalFacetSet: typeof WeakMap.prototype.set,
  Refusal: new () => Error
) {
  const originalRoomRetirementFacets = new WeakMap<object, OriginalRoomRetirementFacet>();
  function readOriginalRoomRetirementFacet(owner: object): OriginalRoomRetirementFacet {
    const own = originalFacetApply(originalFacetGet, originalRoomRetirementFacets, [owner]) as
      OriginalRoomRetirementFacet | undefined;
    if (!own) throw new Refusal();
    return own;
  }
  function registerOriginalRoomRetirementFacet(
    owner: object,
    context: OriginalRoomRetirementFacet
  ): void {
    originalFacetApply(originalFacetSet, originalRoomRetirementFacets, [owner, context]);
  }
  const originalDocumentCaptureFacets = new WeakMap<object, OriginalDocumentCaptureFacet>();
  function readOriginalDocumentCaptureFacet(owner: object): OriginalDocumentCaptureFacet {
    const own = originalFacetApply(originalFacetGet, originalDocumentCaptureFacets, [owner]) as
      OriginalDocumentCaptureFacet | undefined;
    if (!own) throw new Refusal();
    return own;
  }
  function registerOriginalDocumentCaptureFacet(
    owner: object,
    context: OriginalDocumentCaptureFacet
  ): void {
    originalFacetApply(originalFacetSet, originalDocumentCaptureFacets, [owner, context]);
  }
  const originalRoomProducerFacets = new WeakMap<object, OriginalRoomProducerFacet>();
  function readOriginalRoomProducerFacet(owner: object): OriginalRoomProducerFacet {
    const own = originalFacetApply(originalFacetGet, originalRoomProducerFacets, [owner]) as
      OriginalRoomProducerFacet | undefined;
    if (!own) throw new Refusal();
    return own;
  }
  function registerOriginalRoomProducerFacet(
    owner: object,
    context: OriginalRoomProducerFacet
  ): void {
    originalFacetApply(originalFacetSet, originalRoomProducerFacets, [owner, context]);
  }
  const originalCurrentEntryFacets = new WeakMap<object, OriginalCurrentEntryFacet>();
  function readOriginalCurrentEntryFacet(owner: object): OriginalCurrentEntryFacet {
    const own = originalFacetApply(originalFacetGet, originalCurrentEntryFacets, [owner]) as
      OriginalCurrentEntryFacet | undefined;
    if (!own) throw new Refusal();
    return own;
  }
  function registerOriginalCurrentEntryFacet(
    owner: object,
    context: OriginalCurrentEntryFacet
  ): void {
    originalFacetApply(originalFacetSet, originalCurrentEntryFacets, [owner, context]);
  }
  const originalEditorSaveSelectionFacets = new WeakMap<object, OriginalEditorSaveSelectionFacet>();
  function readOriginalEditorSaveSelectionFacet(owner: object): OriginalEditorSaveSelectionFacet {
    const own = originalFacetApply(originalFacetGet, originalEditorSaveSelectionFacets, [owner]) as
      OriginalEditorSaveSelectionFacet | undefined;
    if (!own) throw new Refusal();
    return own;
  }
  function registerOriginalEditorSaveSelectionFacet(
    owner: object,
    context: OriginalEditorSaveSelectionFacet
  ): void {
    originalFacetApply(originalFacetSet, originalEditorSaveSelectionFacets, [owner, context]);
  }
  const originalTokenNativeInputFacets = new WeakMap<object, OriginalTokenNativeInputFacet>();
  function readOriginalTokenNativeInputFacet(owner: object): OriginalTokenNativeInputFacet {
    const own = originalFacetApply(originalFacetGet, originalTokenNativeInputFacets, [owner]) as
      OriginalTokenNativeInputFacet | undefined;
    if (!own) throw new Refusal();
    return own;
  }
  function registerOriginalTokenNativeInputFacet(
    owner: object,
    context: OriginalTokenNativeInputFacet
  ): void {
    originalFacetApply(originalFacetSet, originalTokenNativeInputFacets, [owner, context]);
  }
  const originalTokenIssuanceFacets = new WeakMap<object, OriginalTokenIssuanceFacet>();
  function readOriginalTokenIssuanceFacet(owner: object): OriginalTokenIssuanceFacet {
    const own = originalFacetApply(originalFacetGet, originalTokenIssuanceFacets, [owner]) as
      OriginalTokenIssuanceFacet | undefined;
    if (!own) throw new Refusal();
    return own;
  }
  function registerOriginalTokenIssuanceFacet(
    owner: object,
    context: OriginalTokenIssuanceFacet
  ): void {
    originalFacetApply(originalFacetSet, originalTokenIssuanceFacets, [owner, context]);
  }
  const originalMountedPresenceFacets = new WeakMap<object, OriginalMountedPresenceFacet>();
  function readOriginalMountedPresenceFacet(owner: object): OriginalMountedPresenceFacet {
    const own = originalFacetApply(originalFacetGet, originalMountedPresenceFacets, [owner]) as
      OriginalMountedPresenceFacet | undefined;
    if (!own) throw new Refusal();
    return own;
  }
  function registerOriginalMountedPresenceFacet(
    owner: object,
    context: OriginalMountedPresenceFacet
  ): void {
    originalFacetApply(originalFacetSet, originalMountedPresenceFacets, [owner, context]);
  }
  const originalEventAdmissionFacets = new WeakMap<object, OriginalEventAdmissionFacet>();
  function readOriginalEventAdmissionFacet(owner: object): OriginalEventAdmissionFacet {
    const own = originalFacetApply(originalFacetGet, originalEventAdmissionFacets, [owner]) as
      OriginalEventAdmissionFacet | undefined;
    if (!own) throw new Refusal();
    return own;
  }
  function registerOriginalEventAdmissionFacet(
    owner: object,
    context: OriginalEventAdmissionFacet
  ): void {
    originalFacetApply(originalFacetSet, originalEventAdmissionFacets, [owner, context]);
  }
  const originalPresenceExpiryFacets = new WeakMap<object, OriginalPresenceExpiryFacet>();
  function readOriginalPresenceExpiryFacet(owner: object): OriginalPresenceExpiryFacet {
    const own = originalFacetApply(originalFacetGet, originalPresenceExpiryFacets, [owner]) as
      OriginalPresenceExpiryFacet | undefined;
    if (!own) throw new Refusal();
    return own;
  }
  function registerOriginalPresenceExpiryFacet(
    owner: object,
    context: OriginalPresenceExpiryFacet
  ): void {
    originalFacetApply(originalFacetSet, originalPresenceExpiryFacets, [owner, context]);
  }
  const originalReadProjectionFacets = new WeakMap<object, OriginalReadProjectionFacet>();
  function readOriginalReadProjectionFacet(owner: object): OriginalReadProjectionFacet {
    const own = originalFacetApply(originalFacetGet, originalReadProjectionFacets, [owner]) as
      OriginalReadProjectionFacet | undefined;
    if (!own) throw new Refusal();
    return own;
  }
  function registerOriginalReadProjectionFacet(
    owner: object,
    context: OriginalReadProjectionFacet
  ): void {
    originalFacetApply(originalFacetSet, originalReadProjectionFacets, [owner, context]);
  }
  const originalExpiredReplayFacets = new WeakMap<object, OriginalExpiredReplayFacet>();
  function readOriginalExpiredReplayFacet(owner: object): OriginalExpiredReplayFacet {
    const own = originalFacetApply(originalFacetGet, originalExpiredReplayFacets, [owner]) as
      OriginalExpiredReplayFacet | undefined;
    if (!own) throw new Refusal();
    return own;
  }
  function registerOriginalExpiredReplayFacet(
    owner: object,
    context: OriginalExpiredReplayFacet
  ): void {
    originalFacetApply(originalFacetSet, originalExpiredReplayFacets, [owner, context]);
  }
  const originalTokenStreamFacets = new WeakMap<object, Readonly<OriginalTokenStreamFacet>>();
  function readOriginalTokenStreamFacet(owner: object): Readonly<OriginalTokenStreamFacet> {
    const own = originalFacetApply(originalFacetGet, originalTokenStreamFacets, [owner]) as
      Readonly<OriginalTokenStreamFacet> | undefined;
    if (!own) throw new Refusal();
    return own;
  }
  function registerOriginalTokenStreamFacet(
    owner: object,
    context: Readonly<OriginalTokenStreamFacet>
  ): void {
    originalFacetApply(originalFacetSet, originalTokenStreamFacets, [owner, context]);
  }
  return {
    readOriginalRoomRetirementFacet,
    registerOriginalRoomRetirementFacet,
    readOriginalDocumentCaptureFacet,
    registerOriginalDocumentCaptureFacet,
    readOriginalRoomProducerFacet,
    registerOriginalRoomProducerFacet,
    readOriginalCurrentEntryFacet,
    registerOriginalCurrentEntryFacet,
    readOriginalEditorSaveSelectionFacet,
    registerOriginalEditorSaveSelectionFacet,
    readOriginalTokenNativeInputFacet,
    registerOriginalTokenNativeInputFacet,
    readOriginalTokenIssuanceFacet,
    registerOriginalTokenIssuanceFacet,
    readOriginalMountedPresenceFacet,
    registerOriginalMountedPresenceFacet,
    readOriginalEventAdmissionFacet,
    registerOriginalEventAdmissionFacet,
    readOriginalPresenceExpiryFacet,
    registerOriginalPresenceExpiryFacet,
    readOriginalReadProjectionFacet,
    registerOriginalReadProjectionFacet,
    readOriginalExpiredReplayFacet,
    registerOriginalExpiredReplayFacet,
    readOriginalTokenStreamFacet,
    registerOriginalTokenStreamFacet,
  };
}
