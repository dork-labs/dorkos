/**
 * How long a new standing permission would last, in words a button can carry.
 *
 * The number is a setting, never a constant: the button says "for 8 hours"
 * because the window is set to 480 minutes, and it says something else the moment
 * somebody changes it. A hardcoded phrase would be a promise the product stops
 * keeping without anybody noticing.
 *
 * The schema bounds the window between 5 minutes and one day, so those are the
 * only shapes this has to read well in.
 *
 * @param minutes - The configured window, in minutes.
 * @returns A phrase like `8 hours`, `1 hour`, `45 minutes`, or `1 day`.
 */
export function formatTrustWindow(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0 minutes';
  if (minutes >= 1440) return '1 day';
  if (minutes < 60) return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hourPart = hours === 1 ? '1 hour' : `${hours} hours`;
  if (rest === 0) return hourPart;
  return `${hourPart} ${rest} min`;
}
