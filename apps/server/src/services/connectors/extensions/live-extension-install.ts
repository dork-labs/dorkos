/**
 * The facts about one running extension that its connection grants are
 * checked against (DOR-3547). The extension host builds this from the copy it
 * started, never from anything the extension sent, and the broker re-reads it
 * on every call.
 *
 * @module services/connectors/extensions/live-extension-install
 */
import type { ExtensionApprovalOrigin, ExtensionApprovalScope } from '@dorkos/db';
import type { ConnectionDeclaration } from '@dorkos/extension-api/manifest';

/** One running extension copy, as its connection grants see it. */
export interface LiveExtensionInstall {
  /** The extension id, from the manifest the host validated. */
  readonly extensionId: string;
  /** The extensions folder the copy lives in. */
  readonly scope: ExtensionApprovalScope;
  /**
   * The copy's folder with every link resolved by `fs.realpathSync.native`,
   * so a case-only variant on a case-insensitive disk is the same folder
   * (Security P4-1).
   */
  readonly realPath: string;
  /**
   * Why this copy's code may be trusted not to change without a person, or
   * `null` when it may hold no grant at all (path-trust, dev-link and
   * agent-built copies; Security Q7).
   */
  readonly origin: ExtensionApprovalOrigin | null;
  /** The normalized `owner/repo` of a `trusted_source` copy. */
  readonly originSource?: string;
  /** The digest of the files this copy runs now, or `undefined` when unknown. */
  readonly liveFilesDigest: string | undefined;
  /** The manifest version. */
  readonly version: string;
  /** What the manifest declares under `serverCapabilities.connections`. */
  readonly declarations: readonly ConnectionDeclaration[];
  /**
   * Whether the copy runs right now in its own process, and that process's
   * self-check said `node:sqlite` can't load there (Security S2). Read live
   * on every call, so a stopped or restarted child answers `false`.
   */
  readonly isolated: () => boolean;
}
