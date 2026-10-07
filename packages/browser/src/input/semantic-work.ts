import { RequestIdSchema, type RequestId } from '../ids.js';
import type { NativeInputStep } from './types.js';
import { SemanticActionV1Schema } from '@dorkos/shared/browser-semantic-schemas';
import type { BrowserBinding } from '../contracts.js';
import { parseBrowserBinding } from '../contracts.js';
import { sameBinding } from './binding.js';

/** Opaque Work stays within the original engine and queue; request shapes confer no authority. */
declare const semanticWorkBrand: unique symbol;
export interface OwnedSemanticInputWork {
  readonly [semanticWorkBrand]: never;
}
export interface SemanticQueueOperation {
  current(): boolean;
  /** Actual native reader re-resolves the original lease/DOM object and each original action step. */
  execute(
    signal: AbortSignal,
    check: () => void,
    dispatch: (step: NativeInputStep) => Promise<void>
  ): Promise<void>;
}
type Cell = {
  readonly binding: BrowserBinding;
  readonly requestId: RequestId;
  readonly current: () => boolean;
  readonly execute: SemanticQueueOperation['execute'];
  owner?: object;
};
const cells = new WeakMap<object, Cell>();
/** Constructor-private issuer owns one exact parsed request and the consumed native operation receiver. */
export function createSemanticInputIssuer() {
  const issued = new WeakSet<object>();
  return Object.freeze({
    issue(
      bindingValue: unknown,
      requestValue: unknown,
      operation: SemanticQueueOperation
    ): OwnedSemanticInputWork {
      const binding = Object.freeze(parseBrowserBinding(bindingValue));
      const request = SemanticActionV1Schema.parse(requestValue);
      const identity = request.identity;
      const requestBinding = parseBrowserBinding({
        browserId: identity.browserId,
        browserGeneration: identity.browserGeneration,
        tabId: identity.tabId,
        navigationGeneration: identity.navigationGeneration,
        viewportVersion: identity.viewportVersion,
        epoch: identity.epoch,
        inputGeneration: identity.inputGeneration,
      });
      if (!sameBinding(requestBinding, binding)) throw new Error('SEMANTIC_BINDING_REFUSED');
      const requestId = RequestIdSchema.parse(request.requestId);
      const current = operation.current.bind(operation);
      const execute = operation.execute.bind(operation);
      const token = Object.freeze(Object.create(null)) as OwnedSemanticInputWork;
      cells.set(token, { binding, requestId, current, execute });
      issued.add(token);
      return token;
    },
    invalidate(token: OwnedSemanticInputWork) {
      if (issued.has(token)) cells.delete(token);
    },
  });
}
/** Parent preflight observes only an unconsumed original token; queue consumption remains exclusive. */
export function inspectSemanticInputWork(token: OwnedSemanticInputWork) {
  const cell = cells.get(token);
  if (!cell || cell.owner) throw new Error('SEMANTIC_WORK_REFUSED');
  return Object.freeze({ binding: cell.binding, requestId: cell.requestId });
}
/** Queue receives an exact original cell only once, never a replay or caller callback. */
export function consumeSemanticInputWork(token: OwnedSemanticInputWork, owner: object) {
  const cell = cells.get(token);
  if (!cell || cell.owner) throw new Error('SEMANTIC_WORK_REFUSED');
  cell.owner = owner;
  return Object.freeze({ binding: cell.binding, requestId: cell.requestId });
}
/** Fallible grant checks precede the caller's final callback-free canonical binding fence. */
export function semanticInputCurrent(token: OwnedSemanticInputWork, owner: object): boolean {
  const cell = cells.get(token);
  return (
    !!cell &&
    cell.owner === owner &&
    cell.current() &&
    cells.get(token) === cell &&
    cell.owner === owner
  );
}
/** Execute only work consumed by this queue owner, retaining its original admission checks. */
export function executeSemanticInputWork(
  token: OwnedSemanticInputWork,
  owner: object,
  signal: AbortSignal,
  check: () => void,
  dispatch: (step: NativeInputStep) => Promise<void>
): Promise<void> {
  const cell = cells.get(token);
  if (!cell || cell.owner !== owner) throw new Error('SEMANTIC_WORK_REFUSED');
  check();
  return cell.execute(signal, check, dispatch);
}
/** The original queue disposes only its own cell, after original native settlement. */
export function settleSemanticInputWork(token: OwnedSemanticInputWork, owner: object): void {
  if (cells.get(token)?.owner === owner) cells.delete(token);
}
