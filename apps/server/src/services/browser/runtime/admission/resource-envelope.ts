import { z } from 'zod';
/** Populated only in a reviewed release catalogue after the original resource window.
 * Sampling interval and limits have no defaults; request/config JSON never supplies them. */
export const ReviewedBrowserResourceEnvelopeSchema = z
  .strictObject({
    profiles: z.number().int().min(1).max(64).safe(),
    browsers: z.number().int().min(1).max(16).safe(),
    tabsPerBrowser: z.number().int().min(1).max(64).safe(),
    viewersPerBrowser: z.number().int().min(1).max(16).safe(),
    captureMinimumIntervalMilliseconds: z.number().positive().max(2000),
    maximumCPUPercent: z.number().positive().max(100),
    minimumAvailableMemoryBytes: z.number().int().nonnegative().safe(),
    maximumBrowserRSSBytes: z.number().int().positive().safe(),
    maximumObservationAgeMilliseconds: z.number().positive(),
    samplingIntervalMilliseconds: z.number().positive().max(2147483647),
  })
  .refine((value) => value.samplingIntervalMilliseconds <= value.maximumObservationAgeMilliseconds);
export type ReviewedBrowserResourceEnvelope = Readonly<
  z.infer<typeof ReviewedBrowserResourceEnvelopeSchema>
>;
