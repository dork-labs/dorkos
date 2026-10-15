import type { LocalBrowserPreparation } from '@dorkos/shared/local-browser';

/** Current component progress only; no aggregate or timed estimate is invented. */
export function BrowserPreparation({ preparation }: { preparation: LocalBrowserPreparation }) {
  const description =
    preparation.stage === 'checking'
      ? 'Checking browser files…'
      : preparation.stage === 'launching'
        ? 'Opening the browser…'
        : preparation.component === 'chromium'
          ? 'Downloading the browser…'
          : preparation.component === 'headless-shell'
            ? 'Downloading browser support…'
            : preparation.component === 'ffmpeg'
              ? 'Downloading video support…'
              : 'Downloading browser files…';
  const component =
    preparation.component === 'chromium'
      ? 'Browser download'
      : preparation.component === 'headless-shell'
        ? 'Browser support download'
        : 'Video support download';
  const percent =
    preparation.stage === 'downloading' &&
    preparation.component &&
    preparation.percent !== null &&
    Number.isFinite(preparation.percent) &&
    preparation.percent >= 0 &&
    preparation.percent <= 100
      ? preparation.percent
      : null;
  return (
    <div className="space-y-1 text-xs" aria-live="polite">
      <p>{description}</p>
      {percent !== null && (
        <>
          <progress aria-label={component} max={100} value={percent} className="w-full" />
          <p>{percent}%</p>
        </>
      )}
    </div>
  );
}
