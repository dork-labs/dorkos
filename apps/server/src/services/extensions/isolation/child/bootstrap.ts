/**
 * The entry DorkOS forks for each isolated extension (DOR-2686, spec §4).
 *
 * Bundled on its own (`extension-child.cjs` beside the server bundle in the
 * CLI and desktop builds; bundled on demand in development, see
 * `child-entry.ts`), with `express` and the extension API inside it, and
 * started by `isolated-host.ts` with Node's permission model on.
 *
 * In this order, before any extension code is evaluated:
 *
 * 1. **Self-check.** Report what Node's permission model allows, as the very
 *    first message. The host refuses to go on unless the model is on and
 *    every capability is off; there is no fallback to running in-process.
 * 2. Wait for `init`, which the host sends only after accepting the report.
 * 3. **Guards.** Install the network guard, the process guard (signals only
 *    to itself), and build the `child_process` shim.
 * 4. **Load the bundle** with the injected `require`.
 *
 * Exporting `register` and carrying `ctx` across the boundary arrive in a
 * later phase. Until then, a test seam (`init.testSeams`) lets the host call
 * the bundle's exported `probes` so the enforcement suites can drive a real
 * child.
 *
 * Standard output and error are left to the host, which forwards them to its
 * log with a rate cap.
 *
 * @module services/extensions/isolation/child/bootstrap
 */
import os from 'node:os';
import express from 'express';
import * as extensionApi from '@dorkos/extension-api';
import * as extensionServerApi from '@dorkos/extension-api/server';
import type { ChildMessage, HostMessage, InitMessage, PermissionReport } from '../ipc-protocol.js';
import { createChildProcessShim } from './child-process-shim.js';
import { createInjectedRequire, loadBundle } from './load-bundle.js';
import { installNetGuard } from './net-guard.js';
import { installProcessGuard } from './process-guard.js';

/** The shape of Node's permission API, which `@types/node` may not declare. */
interface PermissionApi {
  has(scope: string, reference?: string): boolean;
}

/** `process.send`, captured before any extension code could replace it. */
const sendRaw = process.send?.bind(process);

/**
 * Send one message to the host.
 *
 * @param message - The message.
 */
function send(message: ChildMessage): void {
  sendRaw?.(message);
}

/**
 * What Node's permission model allows this process, read before anything
 * else runs. `readsBootstrap` is the positive control: `has()` answers
 * `false` for a scope it does not know, so a report of all-`false` alone
 * could mean the scopes were renamed rather than denied.
 */
function permissionReport(): PermissionReport {
  const dorkHome = process.argv[2];
  const permission = (process as unknown as { permission?: PermissionApi }).permission;
  const present = typeof permission?.has === 'function';
  const has = (scope: string, reference?: string): boolean => {
    if (!present) return true;
    try {
      return permission!.has(scope, reference);
    } catch {
      return true;
    }
  };
  return {
    present,
    readsBootstrap: present && has('fs.read', __filename),
    fsWriteRoot: has('fs.write', '/'),
    fsReadRoot: has('fs.read', '/'),
    // The host passes its data directory as the one argument; a missing one
    // reads as readable, so the check fails closed.
    readsDorkHome:
      typeof dorkHome !== 'string' || dorkHome.length === 0 || has('fs.read', dorkHome),
    inspector: has('inspector'),
    // Every folder above a grant (the host passes them after the data
    // directory): any one readable is a widened grant, so the check fails.
    readableAncestors: process.argv
      .slice(3)
      .filter((dir) => typeof dir === 'string' && has('fs.read', dir)),
    child: has('child'),
    worker: has('worker'),
    addon: has('addon'),
    wasi: has('wasi'),
  };
}

/**
 * This computer's own interface addresses, for the guard's own-port rule.
 * Read here, in the child, before any extension code runs.
 */
function localAddresses(): string[] {
  try {
    return Object.values(os.networkInterfaces())
      .flat()
      .map((info) => info?.address)
      .filter((address): address is string => typeof address === 'string');
  } catch {
    return [];
  }
}

/**
 * Turn anything thrown into a message the host can carry.
 *
 * @param err - What was thrown.
 */
function describe(err: unknown): { code?: string; message: string } {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return { code: typeof code === 'string' ? code : undefined, message: err.message };
  }
  return { message: String(err) };
}

/** Start the child. */
function main(): void {
  if (!sendRaw) {
    // Not started by DorkOS: there is nobody to report to.
    process.exit(1);
  }

  let started = false;
  let receiveRun: ((message: HostMessage) => void) | null = null;
  let probes: Record<string, (...args: unknown[]) => unknown> | null = null;

  // A lost parent means DorkOS stopped: stop too, never linger.
  process.on('disconnect', () => process.exit(0));

  /**
   * Start the extension once the host has accepted the self-check.
   *
   * @param init - The host's `init` message.
   */
  const start = (init: InitMessage): void => {
    installNetGuard({
      allowNet: init.allowNet,
      dorkosPort: init.dorkosPort,
      ownAddresses: localAddresses(),
    });
    installProcessGuard();
    const shim = createChildProcessShim(
      { send: (message) => send(message as ChildMessage) },
      { platform: process.platform, allowRun: init.allowRun }
    );
    receiveRun = shim.receive;
    const injected = createInjectedRequire(
      {
        express: () => express,
        '@dorkos/extension-api': () => extensionApi,
        '@dorkos/extension-api/server': () => extensionServerApi,
        child_process: () => shim.module,
        'node:child_process': () => shim.module,
      },
      __filename
    );
    try {
      const exported = loadBundle(init.bundlePath, injected) as Record<string, unknown> | null;
      const found = exported?.probes;
      if (init.testSeams && found && typeof found === 'object') {
        probes = found as Record<string, (...args: unknown[]) => unknown>;
      }
      send({ type: 'loaded', ok: true });
    } catch (err) {
      send({ type: 'loaded', ok: false, error: describe(err).message });
    }
  };

  process.on('message', (raw: unknown) => {
    const message = raw as HostMessage;
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
    if (!started) {
      if (message.type === 'init') {
        started = true;
        start(message);
      }
      return;
    }
    switch (message.type) {
      case 'ping':
        send({ type: 'pong', n: message.n });
        break;
      case 'stop':
        process.exit(0);
        break;
      case 'probe': {
        const probe = probes?.[message.name];
        if (typeof probe !== 'function') {
          send({
            type: 'probe-result',
            id: message.id,
            ok: false,
            error: { message: 'No such probe.' },
          });
          break;
        }
        Promise.resolve()
          .then(() => probe(...(Array.isArray(message.args) ? message.args : [])))
          .then(
            (value) => send({ type: 'probe-result', id: message.id, ok: true, value }),
            (err: unknown) =>
              send({ type: 'probe-result', id: message.id, ok: false, error: describe(err) })
          );
        break;
      }
      default:
        receiveRun?.(message);
    }
  });

  send({ type: 'hello', node: process.version, permission: permissionReport() });
}

main();
