import { createFileRoute } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { SignInLandingPage } from '@/layers/features/sign-in-landing';

/** `?landing=<id>`: the record the sign-in's callback left on the server. */
const signedInSearchSchema = z.object({
  landing: z.string().max(64).optional().catch(undefined),
});

/**
 * Where a browser lands after signing in to a service (`/signed-in`). Outside
 * the app shell on purpose: it is a page in a browser tab the sign-in opened,
 * not a place in the app, so it has no sidebar and no tabs.
 */
export const Route = createFileRoute('/signed-in')({
  staticData: { header: null },
  validateSearch: zodValidator(signedInSearchSchema),
  component: SignedInRoute,
});

function SignedInRoute() {
  const { landing } = Route.useSearch();
  return <SignInLandingPage landingId={landing ?? ''} />;
}
