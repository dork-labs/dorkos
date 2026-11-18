/**
 * The line under an account's sign-in button when signing in did not work:
 * which account, then why and what to do (DOR-4426). The reason comes from the
 * server, which saw how the sign-in ended; without one, the line says try again.
 *
 * @module entities/runtime/ui/SigninFailure
 */

/**
 * Say which account could not be signed in, and why.
 *
 * @param props.name - The account's name, as the row shows it.
 * @param props.reason - The server's reason and next step, or `null`.
 */
export function SigninFailure({ name, reason }: { name: string; reason: string | null }) {
  return (
    <div role="alert" className="text-destructive text-xs">
      <p>Couldn’t sign in to {name}.</p>
      <p>{reason ?? 'Try again.'}</p>
    </div>
  );
}
