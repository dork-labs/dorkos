import { z } from 'zod';
import { parseValidated } from './validation.js';

const opaqueId = z
  .string()
  .min(22)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
/** Internal schema; runtime generation must supply at least 128 random bits. */
export const ProfileIdSchema = opaqueId.brand<'ProfileId'>();
/** Internal schema for a live browser reference, never a permission. */
export const BrowserIdSchema = opaqueId.brand<'BrowserId'>();
/** Internal schema for a canonical Page reference, never a selector. */
export const TabIdSchema = opaqueId.brand<'TabId'>();
/** Internal schema for a caller's action correlation identifier. */
export const RequestIdSchema = opaqueId.brand<'RequestId'>();

/** Opaque reference to a durable private profile. */
export type ProfileId = z.infer<typeof ProfileIdSchema>;
/** Opaque reference to one live browser lifetime. */
export type BrowserId = z.infer<typeof BrowserIdSchema>;
/** Opaque reference to one live canonical tab. */
export type TabId = z.infer<typeof TabIdSchema>;
/** Opaque request correlation identifier with no embedded input. */
export type RequestId = z.infer<typeof RequestIdSchema>;

/** Validate a profile reference without resolving its filesystem location. */
export function parseProfileId(value: unknown): ProfileId {
  return parseValidated(ProfileIdSchema, value, 'INVALID_ID');
}
/** Validate a live browser reference without performing acquisition. */
export function parseBrowserId(value: unknown): BrowserId {
  return parseValidated(BrowserIdSchema, value, 'INVALID_ID');
}
/** Validate a tab reference without resolving a Page or protocol target. */
export function parseTabId(value: unknown): TabId {
  return parseValidated(TabIdSchema, value, 'INVALID_ID');
}
