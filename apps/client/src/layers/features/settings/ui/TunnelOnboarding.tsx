/** Dark-mode-aware SVG illustration: laptop connected to phone/tablet via dotted lines. */
function ConnectionIllustration() {
  return (
    <svg viewBox="0 0 240 120" className="mx-auto h-24 w-48" aria-hidden="true">
      {/* Laptop */}
      <rect
        x="80"
        y="30"
        width="80"
        height="50"
        rx="4"
        className="fill-none stroke-current"
        strokeWidth="2"
      />
      <rect x="70" y="80" width="100" height="6" rx="2" className="fill-current opacity-30" />
      {/* Screen content indicator */}
      <rect x="90" y="42" width="20" height="2" rx="1" className="fill-current opacity-40" />
      <rect x="90" y="48" width="40" height="2" rx="1" className="fill-current opacity-20" />
      <rect x="90" y="54" width="30" height="2" rx="1" className="fill-current opacity-20" />

      {/* Phone (right) */}
      <rect
        x="195"
        y="35"
        width="28"
        height="45"
        rx="4"
        className="fill-none stroke-current"
        strokeWidth="1.5"
      />
      <circle cx="209" cy="73" r="2" className="fill-current opacity-30" />

      {/* Tablet (left) */}
      <rect
        x="10"
        y="30"
        width="40"
        height="55"
        rx="4"
        className="fill-none stroke-current"
        strokeWidth="1.5"
      />
      <circle cx="30" cy="78" r="2" className="fill-current opacity-30" />

      {/* Dotted connection lines */}
      <line
        x1="160"
        y1="55"
        x2="195"
        y2="55"
        className="stroke-current opacity-40"
        strokeWidth="1.5"
        strokeDasharray="4 3"
      />
      <line
        x1="80"
        y1="55"
        x2="50"
        y2="55"
        className="stroke-current opacity-40"
        strokeWidth="1.5"
        strokeDasharray="4 3"
      />
    </svg>
  );
}

/** Illustration and heading shown in both the setup flow and the landing view. */
export function TunnelOnboarding() {
  return (
    <div className="space-y-3">
      <ConnectionIllustration />
      <p className="text-foreground text-center text-sm font-medium">
        Access DorkOS from any device
      </p>
    </div>
  );
}
