import type { StreamdownTranslations } from 'streamdown';

/**
 * The app's words for the controls Streamdown draws on its own, such as the
 * copy button on every code block (DOR-2871).
 *
 * Streamdown's defaults are Title Case ("Copy Code"); app copy is sentence
 * case. One module-scope object, shared by chat and static markdown, so the
 * two never drift and Streamdown's prop memo sees the same reference.
 */
export const STREAMDOWN_TRANSLATIONS: Partial<StreamdownTranslations> = {
  copyCode: 'Copy code',
  copied: 'Copied',
};
