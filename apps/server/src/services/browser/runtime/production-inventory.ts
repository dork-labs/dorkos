import { getTunnelOrigin } from '../../../lib/trusted-origins.js';
import { tunnelManager } from '../../core/tunnel-manager.js';
import { createServerInventory } from '../egress/broker/server-inventory.js';
/** Passive original main HTTP custody plus every observed tunnel alias, including while Off. */
export function createProductionBrowserServerInventory() {
  const original = createServerInventory({
    instances: [{ id: 'dorkos', listeners: ['main'] }],
    adminAuthorities: [],
    now: () => Number(process.hrtime.bigint() / 1000000n),
  });
  const acquire = original.acquire.bind(original),
    read = original.observe.bind(original),
    retain = original.retainAdministrativeAuthority.bind(original);
  let closed = false,
    closing: Promise<void> | undefined,
    failure: Readonly<{ value: unknown }> | undefined;
  const fail = (value: unknown) => {
    failure ??= { value };
  };
  const sample = () => {
    const actual = getTunnelOrigin();
    if (actual) retain(actual);
  };
  const observe = () => {
    if (closed || failure) throw failure ? failure.value : new Error('BROWSER_INVENTORY_CLOSED');
    sample();
    return read();
  };
  const onStatus = () => {
    if (closed) return;
    try {
      sample();
    } catch (value) {
      fail(value);
    }
  };
  let yes!: (remove: () => void) => void, no!: (value: unknown) => void;
  const ready = new Promise<() => void>((resolve, reject) => {
    yes = resolve;
    no = reject;
  });
  void ready.catch(() => {});
  const close = (): Promise<void> => {
    if (closing) return closing;
    let yes!: () => void, no!: (value: unknown) => void;
    closing = new Promise<void>((resolve, reject) => {
      yes = resolve;
      no = reject;
    });
    closed = true;
    void ready
      .then((remove) => {
        try {
          remove();
        } catch (value) {
          fail(value);
        }
      }, fail)
      .then(() => {
        if (failure) no(failure.value);
        else yes();
      });
    return closing;
  };
  try {
    const off = tunnelManager.off.bind(tunnelManager);
    yes(() => {
      off('status_change', onStatus);
    });
    const on = tunnelManager.on.bind(tunnelManager);
    on('status_change', onStatus);
    sample();
  } catch (value) {
    fail(value);
    no(value);
    void close().catch(() => {});
    throw value;
  }
  return Object.freeze({
    acquire,
    observe,
    readInventory: () => observe().inventory,
    retainAdministrativeAuthority: retain,
    close,
  });
}
