import { z } from 'zod';
import { AbsolutePathSchema, RuntimeDescriptorSchema } from './runtime-descriptor.js';
import type { BrowserBinding } from './contracts.js';
import type { BrowserId } from './ids.js';
import { parseValidated } from './validation.js';

/** PID plus observer-issued birth identity; PID alone never authorizes cleanup. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly birth: string;
}
/** Observed matching liveness; unknown is not permission to reuse a profile. */
export type ProcessObservation = { readonly status: 'alive' | 'dead' | 'unknown' };
/** Owned tree observation with explicit completeness, including after reparenting. */
export interface ProcessTreeObservation {
  readonly status: 'complete' | 'unknown';
  readonly identities: readonly ProcessIdentity[];
}
/** Server-issued broker binding; no website or arbitrary URL policy callback. */
export interface BrokerLeaseBinding {
  readonly browserId: BrowserId;
  readonly browserGeneration: number;
  readonly leaseId: string;
  readonly policyRevision: number;
}
/** Mandatory clocks are injected; validation does not call them or infer host time. */
export interface EngineClock {
  monotonicNow(): number;
  wallNow(): number;
}
/** Injected host observer; the engine must fail closed when observations are incomplete. */
export interface ProcessObserver {
  observe(identity: ProcessIdentity, signal: AbortSignal): Promise<ProcessObservation>;
  descendants(identity: ProcessIdentity, signal: AbortSignal): Promise<ProcessTreeObservation>;
}
/** Narrow injected authority decisions; authentication and room/user grants remain in the server. */
export interface EnginePolicy {
  authorizeAction(
    binding: BrowserBinding,
    signal: AbortSignal
  ): Promise<'allowed' | 'refused' | 'unknown'>;
  verifyBrokerLease(
    binding: BrokerLeaseBinding,
    signal: AbortSignal
  ): Promise<'valid' | 'revoked' | 'unknown'>;
}

const callback = <T>(value: unknown): value is T => typeof value === 'function';
const FixtureNetworkSchema = z
  .object({
    kind: z.literal('fixture'),
    origin: z
      .string()
      .max(256)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            url.origin === value &&
            ['http:', 'https:'].includes(url.protocol) &&
            ['127.0.0.1', '[::1]'].includes(url.hostname) &&
            url.port.length > 0
          );
        } catch {
          return false;
        }
      }),
  })
  .strict();
const ConfigurationSchema = z
  .object({
    dataDir: AbsolutePathSchema,
    runtime: RuntimeDescriptorSchema,
    network: FixtureNetworkSchema,
    clock: z
      .object({
        monotonicNow: z.custom<EngineClock['monotonicNow']>(callback),
        wallNow: z.custom<EngineClock['wallNow']>(callback),
      })
      .strict(),
    processes: z
      .object({
        observe: z.custom<ProcessObserver['observe']>(callback),
        descendants: z.custom<ProcessObserver['descendants']>(callback),
      })
      .strict(),
    policy: z
      .object({
        authorizeAction: z.custom<EnginePolicy['authorizeAction']>(callback),
        verifyBrokerLease: z.custom<EnginePolicy['verifyBrokerLease']>(callback),
      })
      .strict(),
  })
  .strict();

/** Trusted injected engine dependencies, with no root defaults or app-specific identity. */
export type EngineConfiguration = z.infer<typeof ConfigurationSchema>;
/** Private fixture-only destination configuration; validation does not enforce browser networking. */
export type FixtureNetworkPolicy = z.infer<typeof FixtureNetworkSchema>;

/** Validate required dependency shapes; callback behavior and runtime readiness require later proof. */
export function validateEngineConfiguration(value: unknown): EngineConfiguration {
  return parseValidated(ConfigurationSchema, value, 'INVALID_CONFIGURATION', true);
}
