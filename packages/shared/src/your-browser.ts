import { z } from 'zod';

/** Metadata from a tap-only scan. Email belongs only in the person's picker. */
export const YourBrowserKindSchema = z.enum(['chrome', 'edge', 'brave']);
/** Picker-only profile metadata; no avatar field can trigger a remote fetch. */
export const YourBrowserProfileSchema = z
  .object({
    browser: YourBrowserKindSchema,
    directory: z
      .string()
      .max(64)
      .regex(/^(?:Default|Profile [0-9]+)(?![\s\S])/),
    displayName: z.string().min(1).max(120),
    email: z.string().max(254).optional(),
  })
  .strict();
/** A bounded scan response, including browsers whose metadata could not be read. */
export const YourBrowserScanSchema = z
  .object({
    supported: z.boolean(),
    profiles: z.array(YourBrowserProfileSchema).max(300),
    unreadable: z.array(YourBrowserKindSchema).max(3),
  })
  .strict();

/** A supported browser with Chromium profile metadata. */
export type YourBrowserKind = z.infer<typeof YourBrowserKindSchema>;
/** Untrusted metadata that lives only while the person's picker is open. */
export type YourBrowserProfile = z.infer<typeof YourBrowserProfileSchema>;
/** A single explicit scan, never cached or persisted. */
export type YourBrowserScan = z.infer<typeof YourBrowserScanSchema>;
/** A pick carries no email, avatar URL, or browser file path. It grants no access. */
export type YourBrowserChoice = Omit<YourBrowserProfile, 'email'>;
