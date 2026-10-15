import { z } from 'zod';
import { LocalBrowserModeSchema } from '@dorkos/shared/local-browser';
import { STORAGE_KEYS } from '@/layers/shared/lib/constants';

export const LocalBrowserChoiceSchema = z
  .object({
    mode: LocalBrowserModeSchema,
  })
  .strict();
const LegacyLocalBrowserChoiceSchema = z
  .object({
    mode: z.enum(['embedded', 'new-window', 'existing']),
    channel: z.enum(['chrome', 'msedge']),
  })
  .strict();
export type LocalBrowserChoice = z.infer<typeof LocalBrowserChoiceSchema>;
export type LocalBrowserChoiceIssue = 'invalid' | 'unavailable' | 'unsaved' | null;

/** Restore owned choices; retired existing-browser preferences return to the surface default. */
export function readLocalBrowserChoice(): {
  choice: LocalBrowserChoice | null;
  issue: LocalBrowserChoiceIssue;
} {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.LOCAL_BROWSER_CHOICE);
    if (raw === null) return { choice: null, issue: null };
    if (raw.length > 512) return { choice: null, issue: 'invalid' };
    const value: unknown = JSON.parse(raw);
    const parsed = LocalBrowserChoiceSchema.safeParse(value);
    if (parsed.success) return { choice: parsed.data, issue: null };
    const legacy = LegacyLocalBrowserChoiceSchema.safeParse(value);
    if (!legacy.success) return { choice: null, issue: 'invalid' };
    return {
      choice: legacy.data.mode === 'existing' ? null : { mode: legacy.data.mode },
      issue: null,
    };
  } catch (cause) {
    return { choice: null, issue: cause instanceof SyntaxError ? 'invalid' : 'unavailable' };
  }
}

/** Persist only the owned mode; pages and saved logins never enter this preference. */
export function writeLocalBrowserChoice(choice: LocalBrowserChoice | null): boolean {
  try {
    if (choice === null) localStorage.removeItem(STORAGE_KEYS.LOCAL_BROWSER_CHOICE);
    else
      localStorage.setItem(
        STORAGE_KEYS.LOCAL_BROWSER_CHOICE,
        JSON.stringify(LocalBrowserChoiceSchema.parse(choice))
      );
    return true;
  } catch {
    return false;
  }
}
