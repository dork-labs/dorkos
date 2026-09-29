import { useLocation } from '@tanstack/react-router';
import { useExtensionPageAtPath } from '@/layers/shared/model';
import { useExtensions } from '@/layers/features/extensions';
import { ContributedIcon } from '@/layers/shared/ui';
import { BarTitle, OneBar } from './OneBar';

/**
 * The bar over an extension page (`/x/<extensionId>/<path>`, spec
 * `flow-multiproject` §6.5): the page's icon and title as the extension named
 * them, or the extension's own name while the page is not there (loading, or
 * an empty state saying why).
 */
export function ExtensionPageBar() {
  const { pathname } = useLocation();
  const at = useExtensionPageAtPath(pathname);
  const { extensions } = useExtensions();

  const page = at?.match?.page ?? null;
  const title =
    page?.title ??
    extensions.find((extension) => extension.id === at?.extensionId)?.manifest.name ??
    'Add-on';

  return (
    <OneBar
      identity={
        <span className="flex min-w-0 items-center gap-2">
          <ContributedIcon icon={page?.icon} className="text-muted-foreground size-4 shrink-0" />
          <BarTitle>{title}</BarTitle>
        </span>
      }
    />
  );
}
