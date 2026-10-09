import { z } from 'zod';
import { boundedBrowserJson } from './browser-schema-json.js';
const text = z
  .string()
  .max(4096)
  .refine((value) => new TextEncoder().encode(value).length <= 4096);
const origin = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        url.origin === value &&
        !url.hash &&
        !url.search
      );
    } catch {
      return false;
    }
  });
const cookie = z
  .object({
    name: text.min(1),
    value: text,
    domain: z
      .string()
      .min(1)
      .max(253)
      .regex(/^\.?[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u),
    path: z
      .string()
      .min(1)
      .max(2048)
      .refine((value) => value.startsWith('/') && !/[\r\n\0]/u.test(value)),
    expires: z
      .number()
      .finite()
      .min(-1)
      .max(253402300799)
      .refine((value) => value === -1 || value >= 0),
    httpOnly: z.boolean(),
    secure: z.boolean(),
    sameSite: z.enum(['Strict', 'Lax', 'None']),
  })
  .strict();
const state = z
  .object({
    cookies: z.array(cookie).max(64),
    origins: z
      .array(
        z
          .object({
            origin,
            localStorage: z
              .array(z.object({ name: text.min(1), value: text }).strict())
              .max(64)
              .refine((rows) => new Set(rows.map((row) => row.name)).size === rows.length),
          })
          .strict()
      )
      .max(32),
  })
  .strict()
  .refine(
    (value) =>
      value.origins.reduce((count, row) => count + row.localStorage.length, 0) <= 256 &&
      new Set(value.origins.map((row) => row.origin)).size === value.origins.length &&
      new Set(value.cookies.map((row) => JSON.stringify([row.domain, row.path, row.name]))).size ===
        value.cookies.length
  );
/** Explicit cookie/local-storage import; credentials, IndexedDB and profile paths are refused. */
export const BrowserStorageStateSchema = boundedBrowserJson(state);
export type BrowserStorageState = z.infer<typeof BrowserStorageStateSchema>;
