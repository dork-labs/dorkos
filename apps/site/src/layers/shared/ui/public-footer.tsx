import Link from 'next/link';

export function PublicFooter() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="bg-muted/30 border-t">
      <div className="container-default py-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          {/* Brand / Copyright */}
          <div className="space-y-1">
            <p className="text-sm font-medium">Dork Labs</p>
            <p className="text-muted-foreground text-xs">
              © {currentYear} Dork Labs. All rights reserved.
            </p>
          </div>

          {/* Legal Links */}
          <nav className="flex flex-wrap gap-x-6 gap-y-2">
            <Link
              href="/privacy"
              className="text-muted-foreground hover:text-foreground text-sm transition-colors"
            >
              Privacy Policy
            </Link>
            <Link
              href="/terms"
              className="text-muted-foreground hover:text-foreground text-sm transition-colors"
            >
              Terms of Service
            </Link>
            <Link
              href="/cookies"
              className="text-muted-foreground hover:text-foreground text-sm transition-colors"
            >
              Cookie Policy
            </Link>
          </nav>
        </div>
      </div>
    </footer>
  );
}
