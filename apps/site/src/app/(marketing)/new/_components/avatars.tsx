/**
 * Original cartoon avatars for the demo cast — drawn here as inline SVG,
 * inspired by (not copied from) the famous robots they're named after, so
 * the page ships no third-party imagery. `HumanFace` is the "You" avatar;
 * swap it for a real photo by replacing its usage with an `<img>`.
 */

/** Shared props for the cartoon faces. */
export interface FaceProps {
  size?: number;
  className?: string;
}

/** Rosie — teal dome, antenna, visor smile. */
export function RosieFace({ size = 36, className }: FaceProps) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} className={className} aria-hidden="true">
      <circle cx="24" cy="8.5" r="3" fill="#e85d04" />
      <rect x="22.6" y="9" width="2.8" height="6" fill="#9adbe0" />
      <rect x="11" y="14" width="26" height="21" rx="10.5" fill="#4fc7ce" />
      <rect x="15.5" y="20" width="17" height="9.5" rx="4.75" fill="#0f2f33" />
      <circle cx="20.5" cy="24.75" r="2.1" fill="#aefcff" />
      <circle cx="27.5" cy="24.75" r="2.1" fill="#aefcff" />
      <rect x="13" y="36.5" width="22" height="6.5" rx="3.25" fill="#2e8f96" />
      <circle cx="24" cy="39.75" r="1.6" fill="#f5f0e6" />
    </svg>
  );
}

/** Johnny 5 — binocular eyes, expressive brows, gray shoulders. */
export function JohnnyFiveFace({ size = 36, className }: FaceProps) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} className={className} aria-hidden="true">
      <rect x="21" y="25" width="6" height="9" fill="#8d8f94" />
      <rect x="9" y="32" width="30" height="10" rx="4" fill="#b0b3ba" />
      <rect x="12" y="34.5" width="7" height="5" rx="2" fill="#e0625a" />
      <rect x="29" y="34.5" width="7" height="5" rx="2" fill="#e0625a" />
      <rect x="21" y="13" width="6" height="8" fill="#8d8f94" />
      <circle cx="16" cy="17" r="7" fill="#d7dade" />
      <circle cx="32" cy="17" r="7" fill="#d7dade" />
      <circle cx="16" cy="17" r="3.1" fill="#1c2733" />
      <circle cx="32" cy="17" r="3.1" fill="#1c2733" />
      <path d="M9.5 9.5 L21 7.5" stroke="#e0625a" strokeWidth="3" strokeLinecap="round" />
      <path d="M27 7.5 L38.5 9.5" stroke="#e0625a" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** WALL·E — boxy amber body, close-set binocular eyes. */
export function WalleFace({ size = 36, className }: FaceProps) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} className={className} aria-hidden="true">
      <rect x="9" y="27" width="30" height="14" rx="3" fill="#e8a33d" />
      <rect x="12.5" y="30.5" width="10" height="7" rx="1.5" fill="#8a5a22" />
      <rect x="25.5" y="30.5" width="10" height="7" rx="1.5" fill="#8a5a22" />
      <rect x="21.5" y="19" width="5" height="9" fill="#9b9da3" />
      <rect x="7" y="8.5" width="15.5" height="10" rx="5" fill="#c9ccd2" />
      <rect x="25.5" y="8.5" width="15.5" height="10" rx="5" fill="#c9ccd2" />
      <rect x="20" y="11.5" width="8" height="3.5" rx="1.75" fill="#6f7379" />
      <circle cx="14.75" cy="13.5" r="2.7" fill="#20262e" />
      <circle cx="33.25" cy="13.5" r="2.7" fill="#20262e" />
    </svg>
  );
}

/** The person in the room — cartoon for now; swap for a real headshot. */
export function HumanFace({ size = 36, className }: FaceProps) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} className={className} aria-hidden="true">
      <path d="M9 44 q2.5 -13 15 -13 q12.5 0 15 13 z" fill="#e85d04" />
      <circle cx="24" cy="18" r="10" fill="#e8b48c" />
      <path d="M14.5 15.5 a10 10 0 0 1 19 0 q-4.5 -5.5 -9.5 -5.5 q-5 0 -9.5 5.5 z" fill="#3c2a20" />
      <circle cx="20.25" cy="18.5" r="1.5" fill="#2b2018" />
      <circle cx="27.75" cy="18.5" r="1.5" fill="#2b2018" />
      <path
        d="M20.5 22.5 q3.5 2.8 7 0"
        stroke="#2b2018"
        strokeWidth="1.7"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}
