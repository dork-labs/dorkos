/**
 * What an install surface shows when the server would not build a package's
 * permission preview (DOR-2314).
 *
 * A package the server refuses to preview is one it refuses to install: the
 * same validation runs on both. Saying nothing here left the detail sheet
 * reading "No special permissions required" over a package that ships, say,
 * an agent's session settings, and the install button live until the install
 * itself failed. This says plainly that it will not be installed, and why.
 *
 * Lives in the marketplace entity because both the install dialog and the
 * agent creation flow (a marketplace agent's arrival) must say it.
 *
 * @module entities/marketplace/ui/PreviewRefusedNotice
 */
import { ShieldX } from 'lucide-react';

/** The server's reasons, and whether they came from its package checks. */
function reasonsOf(error: unknown): { reasons: string[]; checked: boolean } {
  const body = (error as { body?: { errors?: unknown } } | null)?.body;
  const listed = Array.isArray(body?.errors)
    ? body.errors.filter((e): e is string => typeof e === 'string')
    : [];
  if (listed.length > 0) return { reasons: listed, checked: true };
  return {
    reasons: error instanceof Error && error.message ? [error.message] : [],
    checked: false,
  };
}

/**
 * Whether a preview error is the server REFUSING the package (its package
 * checks answered with reasons), as opposed to a preview that could not be
 * fetched. A refused package is one the server will not install.
 *
 * @param error - The preview query's error.
 */
export function isPreviewRefusal(error: unknown): boolean {
  return reasonsOf(error).checked;
}

/**
 * The refusal notice.
 *
 * @param props.error - The preview query's error.
 */
export function PreviewRefusedNotice({ error }: { error: unknown }) {
  const { reasons, checked } = reasonsOf(error);
  return (
    <div
      role="alert"
      className="border-destructive/40 bg-destructive/5 space-y-2 rounded-md border p-3 text-sm"
    >
      <p className="text-destructive flex items-center gap-2 font-medium">
        <ShieldX className="size-4 shrink-0" aria-hidden />
        DorkOS won&rsquo;t install this package
      </p>
      <p className="text-muted-foreground text-xs">
        {checked
          ? 'It checked the package and found this:'
          : 'It couldn’t check what this package does, so it won’t install it.'}
      </p>
      {reasons.length > 0 && (
        <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-xs [overflow-wrap:anywhere]">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
