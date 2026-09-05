import { Link } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { Button } from './button';

/** Default 404 fallback for routes that don't match. */
export function NotFoundFallback() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      <Search className="text-muted-foreground size-10" />
      <div className="flex flex-col items-center gap-2 text-center">
        <h2 className="text-foreground text-lg font-semibold">Page not found</h2>
        <p className="text-muted-foreground max-w-md text-sm">
          The page you&apos;re looking for doesn&apos;t exist.
        </p>
      </div>
      <Button variant="outline" size="sm" asChild>
        <Link to="/">Back to home</Link>
      </Button>
    </div>
  );
}
