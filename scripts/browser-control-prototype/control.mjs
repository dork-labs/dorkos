import { randomBytes } from 'node:crypto';
import { LIMITS, validateActionReceipt } from './contracts.mjs';

function refuse(code) {
  throw new Error(code);
}
function identifier(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value);
}
function plain(value) {
  return (
    value &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).every(
      (key) => typeof key === 'string' && 'value' in Object.getOwnPropertyDescriptor(value, key)
    )
  );
}
function fields(value, required, optional = []) {
  return (
    plain(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
function boundedInteger(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
function finite(value) {
  return Number.isFinite(value) && Math.abs(value) <= 16384;
}
function string(value, max = 2048) {
  return typeof value === 'string' && value.length <= max;
}

function validStep(step, fixtureOrigin) {
  if (!plain(step)) return false;
  switch (step.type) {
    case 'mouseDown':
    case 'mouseUp':
      return fields(step, ['type', 'button']) && ['left', 'middle', 'right'].includes(step.button);
    case 'mouseMove':
    case 'touch':
      return (
        fields(step, ['type', 'x', 'y']) &&
        finite(step.x) &&
        finite(step.y) &&
        step.x >= 0 &&
        step.y >= 0
      );
    case 'click':
      return (
        fields(step, ['type', 'x', 'y'], ['button']) &&
        finite(step.x) &&
        finite(step.y) &&
        step.x >= 0 &&
        step.y >= 0 &&
        (step.button === undefined || ['left', 'middle', 'right'].includes(step.button))
      );
    case 'keyDown':
    case 'keyUp':
      return fields(step, ['type', 'key']) && string(step.key, 64) && step.key.length > 0;
    case 'text':
    case 'compositionCommit':
      return fields(step, ['type', 'text']) && string(step.text);
    case 'composition':
      return (
        fields(step, ['type', 'text'], ['selectionStart', 'selectionEnd']) &&
        string(step.text) &&
        ['selectionStart', 'selectionEnd'].every(
          (key) => step[key] === undefined || boundedInteger(step[key], 0, step.text.length)
        )
      );
    case 'wheel':
      return (
        fields(step, ['type', 'deltaX', 'deltaY']) && finite(step.deltaX) && finite(step.deltaY)
      );
    case 'wait':
      return fields(step, ['type', 'ms']) && boundedInteger(step.ms, 0, LIMITS.maxBarrierMs);
    case 'navigate': {
      if (!fields(step, ['type', 'url']) || !string(step.url)) return false;
      try {
        const url = new URL(step.url);
        return (
          ['http:', 'https:'].includes(url.protocol) &&
          url.origin === fixtureOrigin &&
          !url.username &&
          !url.password
        );
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}
function stepsFor(action, fixtureOrigin) {
  if (action?.type !== 'sequence') {
    if (!validStep(action, fixtureOrigin)) refuse('invalid-action');
    return [action];
  }
  if (
    !fields(action, ['type', 'steps']) ||
    !Array.isArray(action.steps) ||
    Object.getPrototypeOf(action.steps) !== Array.prototype ||
    action.steps.length < 1 ||
    action.steps.length > 64 ||
    Reflect.ownKeys(action.steps).length !== action.steps.length + 1
  )
    refuse('invalid-action');
  for (let index = 0; index < action.steps.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(action.steps, String(index));
    if (!descriptor || !('value' in descriptor) || !validStep(descriptor.value, fixtureOrigin))
      refuse('invalid-action');
  }
  return action.steps;
}
async function timed(operation, ms) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('deadline')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Fixture-only participant authority and serialized, revocable browser input. */
export class PrototypeControl {
  #manager;
  #origin;
  #fixtureOrigin;
  #stoppedBrowsers = new Map();
  #participants = new Map();
  #actors = new Map();
  #tabs = new Map();
  #maxQueue;
  #actionTimeoutMs;
  #barrierMs;
  constructor({
    manager,
    origin,
    fixtureOrigin = origin,
    maxQueue = 64,
    actionTimeoutMs = LIMITS.maxBarrierMs,
    barrierMs = LIMITS.maxBarrierMs,
  }) {
    if (
      !manager ||
      !['getTab', 'dispatchInput', 'resetInput', 'closeBrowser'].every(
        (key) => typeof manager[key] === 'function'
      ) ||
      !boundedInteger(maxQueue, 1, 128) ||
      !boundedInteger(actionTimeoutMs, 1, LIMITS.maxBarrierMs) ||
      !boundedInteger(barrierMs, 1, LIMITS.maxBarrierMs)
    )
      refuse('invalid-config');
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      !['http:', 'https:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    )
      refuse('invalid-origin');
    const fixture = new URL(fixtureOrigin);
    if (
      fixture.origin !== fixtureOrigin ||
      !['http:', 'https:'].includes(fixture.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(fixture.hostname)
    )
      refuse('invalid-fixture-origin');
    this.#fixtureOrigin = fixtureOrigin;
    this.#manager = manager;
    this.#origin = origin;
    this.#maxQueue = maxQueue;
    this.#actionTimeoutMs = actionTimeoutMs;
    this.#barrierMs = barrierMs;
  }
  /** Trusted server bootstrap only: never expose this method as a client enrollment route. */
  issueParticipant({ actorId, kind, tabIds, canControl = false }) {
    if (
      !identifier(actorId) ||
      !['agent', 'human'].includes(kind) ||
      typeof canControl !== 'boolean' ||
      !Array.isArray(tabIds) ||
      tabIds.length < 1 ||
      tabIds.length > 128 ||
      !tabIds.every(identifier) ||
      new Set(tabIds).size !== tabIds.length ||
      this.#actors.has(actorId) ||
      this.#participants.size >= 128
    )
      refuse('invalid-participant');
    for (const tabId of tabIds) this.#tab(tabId);
    const token = randomBytes(32).toString('base64url');
    const participant = { actorId, kind, tabIds: new Set(tabIds), canControl };
    this.#participants.set(token, participant);
    this.#actors.set(actorId, participant);
    return token;
  }
  #participant(token, tabId, control = false) {
    const participant = this.#participants.get(token);
    if (!participant) refuse('unauthorized');
    if (tabId !== undefined && !participant.tabIds.has(tabId)) refuse('view-denied');
    if (control && !participant.canControl) refuse('control-denied');
    return participant;
  }
  #tab(tabId) {
    let tab = this.#tabs.get(tabId);
    if (tab) return tab;
    const info = this.#manager.getTab(tabId);
    const stoppedBrowser = this.#stoppedBrowsers.get(info.browserId);
    if (!tab) {
      tab = {
        tabId,
        browserId: info.browserId,
        controllerId: null,
        epoch: 0,
        status: stoppedBrowser ? 'stopped' : 'ready',
        shutdownStatus: stoppedBrowser?.shutdownStatus ?? null,
        tail: Promise.resolve(),
        pending: 0,
        stop: stoppedBrowser?.stop ?? null,
      };
      this.#tabs.set(tabId, tab);
    }
    return tab;
  }
  /** Authenticate requests using a bearer credential and exact configured loopback origin. */
  authorizeRequest({ authorization, origin }) {
    if (origin !== this.#origin) refuse('origin-denied');
    const match =
      typeof authorization === 'string' && /^Bearer ([a-zA-Z0-9_-]{43})$/.exec(authorization);
    if (!match) refuse('unauthorized');
    this.#participant(match[1]);
    return match[1];
  }
  /** View access does not grant input capability. Returned identity cannot mutate authority. */
  authorizeView(token, tabId) {
    const participant = this.#participant(token, tabId);
    this.#tab(tabId);
    return { actorId: participant.actorId, kind: participant.kind };
  }
  /** Inspect control readiness independently from a viewer subscription. */
  state(tabId) {
    const tab = this.#tab(tabId);
    return {
      controllerId: tab.controllerId,
      epoch: tab.epoch,
      status: tab.status,
      shutdownStatus: tab.shutdownStatus,
    };
  }
  /** Claim an idle control seat; the caller waits for the reset barrier before input dispatch. */
  acquire(token, tabId) {
    const participant = this.#participant(token, tabId, true);
    const tab = this.#tab(tabId);
    if (tab.controllerId !== null) refuse('controller-present');
    return this.#switch(tab, participant.actorId);
  }
  /** Current controller explicitly transfers control to a preauthorized participant. */
  handoff(token, tabId, targetActorId) {
    const participant = this.#participant(token, tabId, true);
    const tab = this.#tab(tabId);
    const target = this.#actors.get(targetActorId);
    if (tab.controllerId !== participant.actorId) refuse('not-controller');
    if (!target || !target.canControl || !target.tabIds.has(tabId)) refuse('control-denied');
    return this.#switch(tab, targetActorId);
  }
  /** A human receives immediate acknowledgment; first input waits on a bounded reset barrier. */
  takeover(token, tabId) {
    const participant = this.#participant(token, tabId, true);
    if (participant.kind !== 'human') refuse('human-required');
    return this.#switch(this.#tab(tabId), participant.actorId);
  }
  /** Revoke a disconnected credential, cancelling old input and resetting held browser state. */
  disconnect(token) {
    const participant = this.#participant(token);
    this.#participants.delete(token);
    this.#actors.delete(participant.actorId);
    return [...this.#tabs.values()]
      .filter((tab) => tab.controllerId === participant.actorId)
      .map((tab) => this.#switch(tab, null));
  }
  #switch(tab, controllerId) {
    if (tab.status === 'stopped') refuse('browser-stopped');
    tab.epoch++;
    tab.controllerId = controllerId;
    tab.status = 'barrier';
    const epoch = tab.epoch;
    const previous = tab.tail;
    const barrier = (async () => {
      try {
        await timed(
          previous.then(async () => {
            if (tab.status !== 'stopped') await this.#manager.resetInput(tab.tabId);
          }),
          this.#barrierMs
        );
        if (tab.status === 'stopped') return { status: 'stopped', epoch };
        if (tab.epoch === epoch) tab.status = 'ready';
        return { status: 'ready', epoch };
      } catch {
        this.#stop(tab);
        return { status: 'stopped', epoch };
      }
    })();
    tab.tail = barrier;
    return { epoch, acknowledgedAt: performance.now(), barrier };
  }
  #stop(tab) {
    if (this.#stoppedBrowsers.has(tab.browserId)) return;
    const stop = timed(
      Promise.resolve().then(() => this.#manager.closeBrowser(tab.browserId)),
      this.#barrierMs
    );
    const browser = { stop, shutdownStatus: 'pending' };
    this.#stoppedBrowsers.set(tab.browserId, browser);
    stop.then(
      () => {
        browser.shutdownStatus = 'closed';
        for (const item of this.#tabs.values())
          if (item.browserId === tab.browserId) item.shutdownStatus = 'closed';
      },
      () => {
        browser.shutdownStatus = 'failed';
        for (const item of this.#tabs.values())
          if (item.browserId === tab.browserId) item.shutdownStatus = 'failed';
      }
    );
    for (const affected of this.#tabs.values()) {
      if (affected.browserId !== tab.browserId) continue;
      affected.status = 'stopped';
      affected.shutdownStatus = 'pending';
      affected.controllerId = null;
      affected.epoch++;
      affected.stop = stop;
    }
  }
  #valid(tab, participant, request) {
    if (
      tab.status === 'stopped' ||
      this.#actors.get(participant.actorId) !== participant ||
      tab.controllerId !== participant.actorId ||
      tab.epoch !== request.epoch
    )
      return false;
    try {
      const current = this.#manager.getTab(request.tabId);
      return (
        current.browserId === tab.browserId &&
        current.navigationGeneration === request.navigationGeneration &&
        current.viewportVersion === request.viewportVersion
      );
    } catch {
      return false;
    }
  }
  /** Submit an allowlisted action. Payload/identity errors throw; admitted requests return receipts. */
  submit(token, request) {
    if (
      !fields(request, [
        'requestId',
        'tabId',
        'navigationGeneration',
        'viewportVersion',
        'epoch',
        'action',
      ])
    )
      refuse('invalid-request');
    const participant = this.#participant(token, request.tabId, true);
    // Use the shared receipt validator for IDs/generations without retaining action text in evidence.
    try {
      validateActionReceipt({ ...this.#receipt(participant, request, 'rejected') });
    } catch {
      refuse('invalid-request');
    }
    const steps = stepsFor(request.action, this.#fixtureOrigin);
    if (Buffer.byteLength(JSON.stringify(request)) > LIMITS.maxActionBytes) refuse('payload-limit');
    const tab = this.#tab(request.tabId);
    if (tab.pending >= this.#maxQueue) refuse('queue-full');
    const copy = structuredClone(request);
    const copySteps =
      steps.length === 1 && copy.action.type !== 'sequence' ? [copy.action] : copy.action.steps;
    tab.pending++;
    const deadline = performance.now() + this.#actionTimeoutMs;
    const operation = tab.tail.then(() => this.#run(tab, participant, copy, copySteps, deadline));
    tab.tail = operation.catch(() => {});
    return operation.finally(() => {
      tab.pending--;
    });
  }
  #receipt(participant, request, outcome) {
    return {
      kind: 'action',
      requestId: request.requestId,
      tabId: request.tabId,
      navigationGeneration: request.navigationGeneration,
      viewportVersion: request.viewportVersion,
      actorId: participant.actorId,
      epoch: request.epoch,
      outcome,
    };
  }
  async #run(tab, participant, request, steps, deadline) {
    let dispatched = 0;
    if (performance.now() >= deadline) return this.#receipt(participant, request, 'rejected');
    for (const step of steps) {
      if (!this.#valid(tab, participant, request))
        return this.#receipt(participant, request, dispatched ? 'aborted' : 'rejected');
      const controller = new AbortController();
      let invoked = false;
      try {
        await timed(
          Promise.resolve().then(() => {
            if (!this.#valid(tab, participant, request)) refuse('revoked');
            if (performance.now() >= deadline) refuse('deadline');
            invoked = true;
            return this.#manager.dispatchInput(tab.tabId, step, { signal: controller.signal });
          }),
          Math.max(1, deadline - performance.now())
        );
        dispatched++;
      } catch (error) {
        controller.abort();
        if (error?.message === 'revoked')
          return this.#receipt(participant, request, dispatched ? 'aborted' : 'rejected');
        if (error?.message === 'deadline') {
          if (invoked || dispatched) this.#stop(tab);
          return this.#receipt(
            participant,
            request,
            invoked ? 'in-flight' : dispatched ? 'aborted' : 'rejected'
          );
        }
        // A failed transport may have dispatched a key/button before failing. Reset before further input.
        try {
          await timed(
            Promise.resolve().then(() => this.#manager.resetInput(tab.tabId)),
            this.#barrierMs
          );
        } catch {
          this.#stop(tab);
        }
        return this.#receipt(participant, request, 'failed');
      }
    }
    return this.#receipt(participant, request, 'completed');
  }
}
