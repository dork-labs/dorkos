/**
 * Says out loud that a model menu is a bounded guess, not the real list.
 *
 * Shown when the runtime found no connected credentials: it then offers a
 * shortened slice of every model it has ever heard of, none of which it can
 * confirm you are able to run. Without this the list reads as complete, and a
 * search over it turns that into an active falsehood — typing the name of a
 * model that IS in the catalog returns "No models match" because the search
 * only sees the slice. The fix a person actually needs is naming the cause, so
 * the line ends on the action rather than the apology (DOR-1660).
 *
 * Lives in `shared/ui` because three surfaces render the same capped catalog —
 * the composer picker (`features/status`), the settings Model row
 * (`features/settings`), and the agent execution rows (`entities/agent`) — and
 * one component is what keeps their admission from drifting (DOR-1674).
 *
 * @module shared/ui/unverified-catalog-notice
 */

/**
 * The one-sentence admission that a model catalog is capped and unconfirmed.
 *
 * @param id - Optional element id so a nearby control can point
 *   `aria-describedby` at the admission; without it a screen-reader user
 *   reaches the select and never hears that the list is a bounded guess.
 */
export function UnverifiedCatalogNotice({ id }: { id?: string }) {
  return (
    <p
      id={id}
      className="text-muted-foreground border-border rounded-lg border border-dashed p-2 text-2xs leading-snug"
      data-testid="model-catalog-unverified"
    >
      This is a short list of models nobody has confirmed you can run. Connect a provider to see the
      ones you actually have.
    </p>
  );
}
