import { z } from 'zod';
import { LocalBrowserModeSchema } from '@dorkos/shared/local-browser';
import { STORAGE_KEYS } from '@/layers/shared/lib/constants';

export const LocalBrowserChoiceSchema = z
  .object({
    mode: LocalBrowserModeSchema,
    channel: z.enum(['chrome', 'msedge']),
  })
  .strict();
export type LocalBrowserChoice = z.infer<typeof LocalBrowserChoiceSchema>;
export type LocalBrowserChoiceIssue = 'invalid' | 'unavailable' | 'unsaved' | null;

/** Read only the browser choice; a damaged preference must not silently pick another browser. */
export function readLocalBrowserChoice(): {
  choice: LocalBrowserChoice | null;
  issue: LocalBrowserChoiceIssue;
} {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.LOCAL_BROWSER_CHOICE);
    if (raw === null) return { choice: null, issue: null };
    if (raw.length > 512) return { choice: null, issue: 'invalid' };
    const parsed = LocalBrowserChoiceSchema.safeParse(JSON.parse(raw));
    return parsed.success
      ? { choice: parsed.data, issue: null }
      : { choice: null, issue: 'invalid' };
  } catch (cause) {
    return { choice: null, issue: cause instanceof SyntaxError ? 'invalid' : 'unavailable' };
  }
}

/** Write a validated mode/channel pair; consent, pages, and saved logins never enter this preference. */
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
