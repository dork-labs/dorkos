import { createFileRoute } from '@tanstack/react-router';
import { dorkLinkBeforeLoad } from '@/layers/shared/lib';
import { NotFoundFallback } from '@/layers/shared/ui';

/**
 * `/r/<dork-uri>`: a link to a chat, room, message or agent (DOR-5046). Its
 * `beforeLoad` replaces it with the screen that shows the thing, so the page
 * itself renders only when the link opens nothing. Outside the app shell, like
 * an address the router does not know, so that page is the very same
 * not-found page an unknown address gets.
 */
export const Route = createFileRoute('/r/$')({
  // Outside the shell, so there is no bar: the route either moves on or says not found.
  staticData: { header: null },
  beforeLoad: dorkLinkBeforeLoad,
  component: NotFoundFallback,
});
