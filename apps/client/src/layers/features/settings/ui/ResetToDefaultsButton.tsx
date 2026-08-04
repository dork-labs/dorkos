/**
 * The "Reset to defaults" link a settings panel puts in its header.
 *
 * Presentational only — each panel owns what resetting means and passes the
 * handler. It lives here rather than inline in two tabs because the Appearance
 * and Tools panels had the same markup twice and drifted apart once already.
 *
 * @module features/settings/ui/ResetToDefaultsButton
 */

/** Header action that returns a settings panel to its shipped defaults. */
export function ResetToDefaultsButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-muted-foreground hover:text-foreground text-xs transition-colors duration-150"
    >
      Reset to defaults
    </button>
  );
}
