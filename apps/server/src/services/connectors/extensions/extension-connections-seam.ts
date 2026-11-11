/**
 * The one wired instance of the extension connection services, set at boot
 * (`startup/steps/connector-services.ts`) and read by the extension host when
 * it builds an isolated extension's ctx (DOR-3547). Unset before boot and in
 * tests that don't wire connectors, so an extension then gets no
 * `ctx.connections` at all.
 *
 * @module services/connectors/extensions/extension-connections-seam
 */
import type { Db } from '@dorkos/db';
import type { ExtensionConnectionApprovalStore } from './extension-connection-approvals.js';
import type { ExtensionConnectionReader } from './extension-connection-reader.js';

/** The extension connection services. */
export interface ExtensionConnectionServices {
  /** The canonical database, for the Connections page's account names. */
  readonly db: Db;
  /** The approval store: approve, revoke, list. */
  readonly approvals: ExtensionConnectionApprovalStore;
  /** The host-side reader behind `ctx.connections`. */
  readonly reader: ExtensionConnectionReader;
}

let current: ExtensionConnectionServices | undefined;

/**
 * Wire (or, with `undefined`, unwire) the services.
 *
 * @param services - The services, or undefined.
 */
export function setExtensionConnectionServices(
  services: ExtensionConnectionServices | undefined
): void {
  current = services;
}

/** The wired services, or undefined before boot. */
export function getExtensionConnectionServices(): ExtensionConnectionServices | undefined {
  return current;
}
