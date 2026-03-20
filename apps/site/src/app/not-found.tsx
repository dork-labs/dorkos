import Link from 'next/link';

/**
 * Custom 404 page styled with the Calm Tech design system.
 *
 * Uses the brand orange accent and mono font for a retro-terminal feel
 * consistent with the DorkOS marketing site aesthetic.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="mx-auto max-w-md space-y-8 text-center">
        {/* 404 indicator with brand orange accent */}
        <div className="space-y-4">
          <p className="text-brand-orange/20 font-mono text-8xl font-bold tracking-tighter">404</p>
          <h1 className="text-foreground text-2xl font-semibold tracking-tight">Page not found</h1>
          <p className="text-muted-foreground">
            The page you&apos;re looking for doesn&apos;t exist or has been moved.
          </p>
        </div>

        {/* Actions using marketing button style */}
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Link
            href="/"
            className="marketing-btn bg-charcoal text-cream-white dark:bg-cream-white dark:text-charcoal inline-flex items-center justify-center gap-2"
          >
            Go home
            <span className="cursor-blink" />
          </Link>
          <Link
            href="/docs"
            className="marketing-btn border-border text-foreground inline-flex items-center justify-center gap-2 border"
          >
            Browse docs
          </Link>
        </div>
      </div>
    </div>
  );
}
