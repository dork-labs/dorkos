/** Internal native sender origin; no structural object can register or mint its identity. */
declare const emitterBrand: unique symbol;
export interface OriginalDownstreamRoomEmitter {
  readonly [emitterBrand]: true;
}
export {
  requireOriginalDownstreamRoomEmissionClosed,
  requireOriginalDownstreamRoomEmitterOwner,
  requireOriginalRoomEmitterPrincipalPort,
  sendOriginalRoomResponderScriptStep,
  requireOriginalDownstreamEmissionTransaction,
  sendOriginalRoomResponderEvent,
  sendOriginalDownstreamRoomInsideFrame,
} from './service.js';
