/**
 * The phone's "Add-ons" list: every page an extension added, under the You
 * tab (spec `flow-multiproject` §6.5, N1).
 *
 * A phone has no command palette to type into, so this is where an extension's
 * pages are found there. It is a list inside the You tab and never a fifth
 * destination: extensions add no app chrome of their own (N10), and the strip
 * above it stays the four places DorkOS goes.
 *
 * @module widgets/mobile-tabs/ui/MobileAddOns
 */
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { cn, extensionPageHref } from '@/layers/shared/lib';
import { useMenuExtensionPages } from '@/layers/shared/model';
import { ContributedIcon, TOUCH_TARGET_MIN_H } from '@/layers/shared/ui';

/** The "Add-ons" list, or nothing when no extension added a page. */
export function MobileAddOns() {
  const pages = useMenuExtensionPages();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  if (pages.length === 0) return null;

  return (
    <section aria-labelledby="mobile-add-ons-heading" className="mt-4">
      <h2
        id="mobile-add-ons-heading"
        className="text-muted-foreground px-2 pb-1.5 text-xs font-medium"
      >
        Add-ons
      </h2>
      <ul className="bg-sidebar-accent/60 flex flex-col gap-0.5 rounded-lg p-1">
        {pages.map((page) => {
          const href = extensionPageHref(page.extensionId, page.path);
          const current = pathname === href;
          return (
            <li key={page.id}>
              <button
                type="button"
                onClick={() => void navigate({ href })}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-md px-2.5 text-[13px]',
                  TOUCH_TARGET_MIN_H,
                  current
                    ? 'bg-sidebar-accent text-sidebar-foreground'
                    : 'text-sidebar-foreground/80 hover:bg-sidebar-accent'
                )}
              >
                <ContributedIcon icon={page.icon} className="size-4 shrink-0" />
                <span className="truncate">{page.title}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
