/** Refusal copy for person-only settings at Full autonomy. */
import {
  isScheduledWake,
  personSettingGuidance,
  SCHEDULED_WAKE_GUIDANCE,
} from '../operator/person-setting-guidance.js';

/**
 * What any turn at Full is told when it tries to change a setting only a person may change
 * (DOR-3426): the Full preset or a chat set to Full asks nobody, and the setting is a person's.
 */
export const FULL_PERSON_SETTING_REFUSAL =
  'Only a person can change this setting, and Full autonomy asks nobody, so it was not changed. ' +
  'A person can change it in Settings.';

/**
 * {@link FULL_PERSON_SETTING_REFUSAL}, naming each setting and the area it belongs to when known.
 *
 * @param settings - The settings the call raised, as `personSettingsRaisedForInput` names them.
 */
export function fullPersonSettingRefusal(settings: readonly string[]): string {
  if (settings.length === 0) return FULL_PERSON_SETTING_REFUSAL;
  if (settings.every(isScheduledWake)) return SCHEDULED_WAKE_GUIDANCE;
  const which = settings.length === 1 ? 'this setting' : 'these settings';
  return (
    `Only a person can change ${which}: ${settings.join(', ')}. Full autonomy asks nobody, so ` +
    'nothing was changed. ' +
    personSettingGuidance(
      settings,
      `A person can change ${settings.length === 1 ? 'it' : 'them'} in Settings.`
    )
  );
}
