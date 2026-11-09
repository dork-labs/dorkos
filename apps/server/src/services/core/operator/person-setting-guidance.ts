/** Honest next steps for settings an agent cannot change. */
const SCHEDULED_WAKE_SETTING = 'keepAwake.wakeForScheduledTasks';
export const SCHEDULED_WAKE_GUIDANCE =
  "DorkOS can't wake this computer for scheduled tasks yet. To keep them running, turn on Keep this computer awake in Settings → Tools → Sleep.";

/** Match the exact setting path, including the Full gate's quoted path with its area label. */
export function isScheduledWake(setting: string): boolean {
  return setting === SCHEDULED_WAKE_SETTING || setting.startsWith(`\`${SCHEDULED_WAKE_SETTING}\``);
}

/**
 * Explain the unavailable wake setting without offering to enable it.
 *
 * @param settings - Plain paths or the gate's backtick-quoted paths with area labels.
 * @param fallback - Existing guidance for other settings.
 */
export function personSettingGuidance(settings: readonly string[], fallback: string): string {
  if (!settings.some(isScheduledWake)) return fallback;
  return [
    SCHEDULED_WAKE_GUIDANCE,
    ...(settings.some((setting) => !isScheduledWake(setting))
      ? ['A person can change the other settings in Settings.']
      : []),
  ].join(' ');
}
