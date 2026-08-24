import { ArrowRight, Folder } from 'lucide-react';

/**
 * The DorkOS app icon, reproduced from `apps/desktop/build/icon.svg` (the
 * real macOS icon) rather than a screenshot, so the diagram below stays
 * crisp at any size and never goes stale when Finder's chrome changes.
 * Sized to match the source icon's proportions: a 58.6%-width glyph on a
 * tile with a 17.6% corner radius.
 */
function AppIconGlyph() {
  return (
    <div className="bg-charcoal flex h-11 w-11 items-center justify-center rounded-[8px]">
      <svg
        width="26"
        height="26"
        viewBox="0 0 400 400"
        fill="none"
        className="text-cream-white"
        aria-hidden="true"
      >
        <path
          d="M292.333 0.127L399.833 96.127L400 96.276V292.207L292.207 400H0V0H292.19L292.333 0.127ZM134.5 148V249H235.5V148H134.5Z"
          fill="currentColor"
        />
      </svg>
    </div>
  );
}

/**
 * Inline CSS/SVG diagram of step 1: the DorkOS icon moving into the
 * Applications folder. Decorative — the paragraph beside it already says
 * the same thing in words, so this is hidden from assistive tech.
 */
function DragToApplicationsDiagram() {
  return (
    <div
      className="border-cream-tertiary bg-cream-white mt-4 grid grid-cols-[auto_auto_auto] items-center justify-items-center gap-x-4 gap-y-1.5 rounded-lg border px-6 py-5 sm:gap-x-6"
      aria-hidden="true"
    >
      <AppIconGlyph />
      <ArrowRight className="text-warm-gray-light" size={20} />
      <Folder className="text-warm-gray" size={34} strokeWidth={1.5} />

      <span className="text-warm-gray-light text-3xs font-mono tracking-[0.04em]">DorkOS</span>
      <span />
      <span className="text-warm-gray-light text-3xs font-mono tracking-[0.04em]">
        Applications
      </span>
    </div>
  );
}

/**
 * Two-step Mac install explainer for `/install`. Step 1 opens the
 * downloaded disk image, mounting a Finder window with the DorkOS icon;
 * launching the app from that mounted window (rather than from
 * Applications) runs it off a read-only volume, so it can never update
 * itself. This walks a non-technical reader through the two steps that
 * avoid that trap: drag it into Applications, then open it from there.
 */
export function MacInstallSteps() {
  return (
    <div className="mt-6 max-w-md">
      <ol className="list-none">
        <li>
          <p className="text-warm-gray-light text-2xs font-mono tracking-[0.1em] uppercase">
            Step 1
          </p>
          <p className="text-charcoal mt-1 text-sm">
            Open the file you downloaded, then drag DorkOS into your Applications folder.
          </p>
          <DragToApplicationsDiagram />
        </li>

        <li className="mt-6">
          <p className="text-warm-gray-light text-2xs font-mono tracking-[0.1em] uppercase">
            Step 2
          </p>
          <p className="text-charcoal mt-1 text-sm">
            Open DorkOS from your Applications folder, not from the window that opened in Step 1.
          </p>
          <p className="text-warm-gray-light mt-1 text-xs">
            A copy opened from that window can&apos;t update itself later.
          </p>
        </li>
      </ol>

      <p className="text-warm-gray mt-6 text-sm">
        The first time you open it, macOS asks you to confirm. Click{' '}
        <span className="text-charcoal font-medium">Open</span>. After that, it opens like any other
        app.
      </p>
    </div>
  );
}
