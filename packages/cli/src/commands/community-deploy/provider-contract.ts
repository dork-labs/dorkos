/**
 * Shared validation helpers for machine-readable deployment service responses.
 *
 * @module commands/community-deploy/provider-contract
 */
import { z } from 'zod';

/** Printable, control-free identifier returned by an external service. */
export const ExternalIdentifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

/** Human-readable label that cannot inject terminal controls. */
export const ExternalLabelSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) =>
    [...value].every((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point > 31 && !(point >= 127 && point <= 159);
    })
  );

/** Parse one JSON document without copying its source into an error. */
export function parseExternalJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

/** Reject duplicate stable identities in an external inventory. */
export function requireUniqueExternalIds<T>(
  values: readonly T[],
  identify: (value: T) => string
): void {
  if (new Set(values.map(identify)).size !== values.length) throw new Error('DUPLICATE_IDENTITY');
}
