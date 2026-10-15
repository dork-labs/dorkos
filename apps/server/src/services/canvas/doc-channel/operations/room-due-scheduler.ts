import {
  onOriginalRegisteredRuntimeRelease,
  type RuntimeRegistry,
} from '../../../core/runtime-registry.js';
import { onProjectorTurnBoundary } from '../../../session/session-state-projector.js';
/** Timer hints and owned maintenance. Native authority and eligibility stay in the original engine. */
import { currentRoomDueServicePort, type DocChannelService } from '../service.js';

/** Start original due/maintenance timers; stop closes admission before draining accepted work. */
export function startCurrentRoomDueScheduler(
  service: DocChannelService,
  registry?: RuntimeRegistry
): {
  stop(): Promise<void>;
} {
  const originalSetTimeout = setTimeout;
  const originalClearTimeout = clearTimeout;
  const originalNow = Date.now;
  const port = currentRoomDueServicePort(service);
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let maintenanceTimer: ReturnType<typeof setTimeout> | undefined;
  let maintenance: Promise<void> | undefined;
  let stopResult: Promise<void> | undefined;
  let pumping: Promise<void> | undefined;
  let pendingPump = false;
  let failure: { cause: unknown } | undefined;
  const remember = (cause: unknown) => {
    failure ??= { cause };
  };
  const pump = () => {
    if (stopped || failure || !registry) return;
    if (pumping) {
      pendingPump = true;
      return;
    }
    pendingPump = false;
    // Fixed genuine service and actual registry; projector/timer notifications are hints only.
    const work = Promise.resolve().then(() => {
      if (!stopped) return port.pump(registry);
    });
    pumping = work;
    void work.then(
      () => {
        pumping = undefined;
        // One coalesced hint after actual pump finally released its original locks; never a busy hot loop.
        if (pendingPump && !stopped && !failure) pump();
      },
      (cause) => {
        remember(cause);
        pumping = undefined;
      }
    );
  };
  const arm = () => {
    if (stopped || running || maintenance || failure) return;
    try {
      if (timer !== undefined) originalClearTimeout(timer);
      timer = undefined;
      const due = port.nextDueAt();
      if (due === undefined) return;
      const at = Date.parse(due);
      if (!Number.isFinite(at)) {
        remember(new Error('Original Room deadline is invalid.'));
        return;
      }
      timer = originalSetTimeout(wake, Math.min(2147483647, Math.max(0, at - originalNow())));
      timer.unref?.();
    } catch (cause) {
      remember(cause);
    }
  };
  const armMaintenance = () => {
    if (stopped || running || maintenance || failure || maintenanceTimer !== undefined) return;
    try {
      maintenanceTimer = originalSetTimeout(sweep, 60_000);
      maintenanceTimer.unref?.();
    } catch (cause) {
      remember(cause);
    }
  };
  const wake = () => {
    timer = undefined;
    if (stopped || failure) return;
    if (maintenance) return;
    running = true;
    try {
      port.wake();
    } catch (cause) {
      remember(cause);
    } finally {
      running = false;
    }
    pump();
    arm();
    armMaintenance();
  };
  const sweep = () => {
    maintenanceTimer = undefined;
    if (stopped || running || maintenance || failure) return;
    let done!: () => void;
    // Install cleanup ownership before any fixed policy/native observer can
    // reenter stop. Maintenance itself is synchronous, including both commits.
    maintenance = new Promise<void>((resolve) => {
      done = resolve;
    });
    try {
      port.maintain();
    } catch (cause) {
      remember(cause);
    } finally {
      done();
      maintenance = undefined;
    }
    pump();
    arm();
    armMaintenance();
  };
  let unsubscribe = () => {},
    unwatchTurns = () => {},
    unwatchRelease = () => {};
  const owner = Object.freeze({
    stop() {
      if (stopResult) return stopResult;
      stopped = true;
      const accepted = maintenance,
        acceptedPump = pumping;
      let done!: () => void, refused!: (cause: unknown) => void;
      stopResult = new Promise<void>((resolve, reject) => {
        done = resolve;
        refused = reject;
      });
      let closingPump: Promise<void> | undefined;
      try {
        closingPump = port.stopPump();
      } catch (cause) {
        remember(cause);
      }
      try {
        unwatchRelease();
      } catch (cause) {
        remember(cause);
      }
      try {
        unwatchTurns();
      } catch (cause) {
        remember(cause);
      }
      try {
        unsubscribe();
      } catch (cause) {
        remember(cause);
      }
      try {
        if (timer !== undefined) originalClearTimeout(timer);
      } catch (cause) {
        remember(cause);
      }
      try {
        if (maintenanceTimer !== undefined) originalClearTimeout(maintenanceTimer);
      } catch (cause) {
        remember(cause);
      }
      timer = undefined;
      maintenanceTimer = undefined;
      void (async () => {
        for (const result of await Promise.allSettled([accepted, acceptedPump, closingPump]))
          if (result.status === 'rejected') remember(result.reason);
        if (failure) throw failure.cause;
      })().then(done, refused);
      return stopResult;
    },
  });
  try {
    unsubscribe = port.subscribe(() => {
      arm();
      pump();
    });
    unwatchTurns = registry ? onProjectorTurnBoundary(() => pump()) : () => {};
    unwatchRelease = registry
      ? onOriginalRegisteredRuntimeRelease(registry, () => pump())
      : () => {};
    arm();
    armMaintenance();
    pump();
  } catch (cause) {
    remember(cause);
    // This returns the owned failed scheduler so its exact failure and asynchronous drain remain awaitable.
    void owner.stop().catch(remember);
  }
  return owner;
}
