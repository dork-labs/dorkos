import { z } from 'zod';
import { parseDestination, type CanonicalDestination } from './destination.js';
import { classifyAddress } from './addresses.js';
import { EgressPolicyError } from './errors.js';
import type { DestinationResolver } from './resolution.js';
import { boundedResolver } from './resolution.js';

/** Trusted server ownership, not authenticated merely by possession of these identifiers. */
export interface EgressBinding {
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly browserId: string;
  readonly browserGeneration: number;
}
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const bindingSchema = z
  .object({
    ownerId: id,
    workspaceId: id,
    browserId: id,
    browserGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const port = z.number().int().min(1).max(65535);
const settingsSchema = z
  .object({
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    adminAuthorities: z.array(z.string().max(512)).max(128),
    privateAdminEndpoints: z
      .array(z.object({ address: z.string().max(128), port }).strict())
      .max(128),
    hostInterfaces: z.array(z.string().max(128)).max(256),
  })
  .strict();

/** Immutable source inputs; public edge IPs must not be listed as private admin aliases. */
export interface EgressPolicyOptions {
  readonly revision: number;
  readonly adminAuthorities: readonly string[];
  readonly privateAdminEndpoints: readonly { address: string; port: number }[];
  readonly hostInterfaces: readonly string[];
  readonly resolver: DestinationResolver;
  readonly now?: () => number;
}

/** Validate trusted identity context without treating a caller-provided identifier as authorization. */
export function binding(value: EgressBinding): Readonly<EgressBinding> {
  const result = bindingSchema.safeParse(value);
  if (!result.success) throw new EgressPolicyError('INVALID_BINDING');
  return Object.freeze(result.data);
}

/** Snapshot finite lists and canonical admin authorities; mutable caller lists cannot change policy. */
export function settings(options: EgressPolicyOptions) {
  try {
    const parsed = settingsSchema.parse({
      revision: options.revision,
      adminAuthorities: options.adminAuthorities,
      privateAdminEndpoints: options.privateAdminEndpoints,
      hostInterfaces: options.hostInterfaces,
    });
    if (
      typeof options.resolver !== 'function' ||
      (options.now !== undefined && typeof options.now !== 'function')
    )
      throw new Error();
    const deniedAuthorities = new Set(
      parsed.adminAuthorities.map((value) => parseDestination({ url: value }).authority)
    );
    const deniedEndpoints = new Set(
      parsed.privateAdminEndpoints.map((item) => {
        const address = classifyAddress(item.address);
        if (address.kind === 'global') throw new Error();
        return `${address.address}:${item.port}`;
      })
    );
    const interfaces = new Set(
      parsed.hostInterfaces.map((value) => classifyAddress(value).address)
    );
    return {
      revision: parsed.revision,
      resolver: boundedResolver(options.resolver),
      now: options.now ?? Date.now,
      checkAdmin(destination: CanonicalDestination) {
        if (
          deniedAuthorities.has(destination.authority) ||
          deniedEndpoints.has(`${destination.hostname}:${destination.port}`)
        )
          throw new EgressPolicyError('ADMIN_DENIED');
      },
      checkAddress(address: string, destination: CanonicalDestination) {
        if (deniedEndpoints.has(`${address}:${destination.port}`))
          throw new EgressPolicyError('ADMIN_DENIED');
        if (interfaces.has(address)) throw new EgressPolicyError('ADDRESS_DENIED');
      },
    };
  } catch {
    throw new EgressPolicyError('INVALID_POLICY');
  }
}
