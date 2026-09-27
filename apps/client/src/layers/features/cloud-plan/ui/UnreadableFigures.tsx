/**
 * What a card shows in place of its credit figures when the response did not
 * say what unit they are in.
 *
 * The service names the unit on every amount-bearing response. Without it,
 * any number printed here would be a guess at the scale, so the card says it
 * could not read the figures rather than showing one.
 */
export function UnreadableFigures() {
  return (
    <p className="text-muted-foreground text-xs">
      Couldn’t read the credit figures from your DorkOS account.
    </p>
  );
}
