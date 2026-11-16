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

/** The code the server gives an app that names another app badly (DOR-3293). */
const CALLED_APP_INVALID = 'EXTENSION_CALLED_APP_INVALID';

/** One reason: its text, and the server's code for it when it sent one. */
interface RefusalReason {
  text: string;
  code?: string;
}

/** The server's reasons, and whether they came from its package checks. */
function reasonsOf(error: unknown): { reasons: RefusalReason[]; checked: boolean } {
  const body = (error as { body?: { errors?: unknown; codes?: unknown } } | null)?.body;
  const codes = Array.isArray(body?.codes) ? body.codes : [];
  const listed: RefusalReason[] = Array.isArray(body?.errors)
    ? body.errors.flatMap((text, index) => {
        if (typeof text !== 'string') return [];
        const code = codes[index];
        return [typeof code === 'string' ? { text, code } : { text }];
      })
    : [];
  if (listed.length > 0) return { reasons: listed, checked: true };
  return {
    reasons: error instanceof Error && error.message ? [{ text: error.message }] : [],
    checked: false,
  };
}

/** A reason that leads with a "{App} can’t be installed." headline (DOR-3293). */
const HEADLINE = /^(.+? can’t be installed\.) (.+)$/;

/**
 * One reason, its headline sentence in bold when it has one. An app that
 * names another app badly is worded here, with the package's name exactly as
 * the surface's title shows it (designer, DOR-3293).
 */
function Reason({ reason, packageName }: { reason: RefusalReason; packageName?: string }) {
  const text =
    reason.code === CALLED_APP_INVALID && packageName
      ? `${packageName} can’t be installed. It names another app in a way DorkOS doesn’t accept. Ask its maker for an update.`
      : reason.text;
  const match = HEADLINE.exec(text);
  if (!match) return <>{text}</>;
  return (
    <>
      <strong className="text-foreground font-medium">{match[1]}</strong> {match[2]}
    </>
  );
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
 * @param props.packageName - The package's name as the surface's title shows it.
 */
export function PreviewRefusedNotice({
  error,
  packageName,
}: {
  error: unknown;
  packageName?: string;
}) {
  const { reasons, checked } = reasonsOf(error);
  return (
    <div
      role="alert"
      className="border-destructive/40 bg-destructive/5 space-y-2 rounded-md border p-3 text-sm"
    >
      <p className="text-destructive flex items-center gap-2 font-medium">
        <ShieldX className="size-4 shrink-0" aria-hidden />
        DorkOS won’t install this package
      </p>
      <p className="text-muted-foreground text-xs">
        {checked ? 'What it found:' : 'It couldn’t check what this package does.'}
      </p>
      {reasons.length > 0 && (
        <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-xs [overflow-wrap:anywhere]">
          {reasons.map((reason) => (
            <li key={reason.text}>
              <Reason reason={reason} {...(packageName ? { packageName } : {})} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
