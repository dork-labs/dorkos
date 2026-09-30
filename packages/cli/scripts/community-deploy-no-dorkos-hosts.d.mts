/**
 * Types for the DorkOS-host guard preload (`community-deploy-no-dorkos-hosts.mjs`). The preload is
 * plain JavaScript because the installed launcher loads it with bare `node --import`.
 *
 * @module scripts/community-deploy-no-dorkos-hosts
 */

/** The environment variable naming the file every refused attempt is appended to. */
export declare const NO_DORKOS_HOSTS_RECORD_VARIABLE: 'DORKOS_NO_DORKOS_HOSTS_RECORD';

/** One refused attempt, as recorded: where it was made and the DorkOS host it named. */
export interface DorkosHostRefusal {
  /** The seam that refused it (`fetch`, `https.request`, `net.connect`, `spawn`, ...). */
  seam: string;
  /** The DorkOS host it named. */
  host: string;
}

/** One process the guard loaded into, and the process that started it. */
export interface DorkosGuardLoad {
  /** The guarded process's pid. */
  loaded: number;
  /** Its parent's pid: the gate for a launcher it spawned directly. */
  parent: number;
}

/** Reduce a host, `host:port`, bracketed IPv6 literal or URL to a bare lowercase host name. */
export declare function normalizeHost(value: unknown): string;

/** The host of `DORKOS_CLOUD_URL` in `environment`, as a one-item list, or an empty list. */
export declare function cloudHostsFrom(
  environment?: Readonly<Record<string, string | undefined>>
): string[];

/** Whether `value` is `dorkos.ai`, a subdomain of it, or one of `extraHosts`. */
export declare function isDorkosHost(value: unknown, extraHosts?: readonly string[]): boolean;

/** The first DorkOS host named anywhere in `text`, or `null`. */
export declare function findDorkosHostInText(
  text: unknown,
  extraHosts?: readonly string[]
): string | null;

/** The error a refused attempt fails with. */
export declare class DorkosHostRefusedError extends Error {
  /** Stable code for the refusal. */
  readonly code: 'DORKOS_HOST_REFUSED';
  /** Where the attempt was made. */
  readonly seam: string;
  /** The DorkOS host it named. */
  readonly host: string;
  /** Create the error for one refused attempt. */
  constructor(seam: string, host: string);
}

/** Install the guard; returns a function that restores every patched seam. */
export declare function installNoDorkosHostsGuard(options: {
  recordPath: string;
  extraHosts?: readonly string[];
}): () => void;
