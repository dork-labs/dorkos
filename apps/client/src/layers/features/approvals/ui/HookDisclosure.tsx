import type { readHookDisclosure } from '../lib/hook-disclosure';
import { hookWhen } from '../lib/hook-disclosure';

/** Spaces are display tokens only; words supplied by a package never become chips. */
export function HookCommand({ value }: { value: string }) {
  return (
    <>
      {value.split(/( {3,})/u).map((part, index) =>
        /^ {3,}$/u.test(part) ? (
          <span
            key={index}
            role="img"
            aria-label={`${part.length} spaces`}
            data-slot="hook-space-token"
            className="border-status-warning-border bg-status-warning-bg text-status-warning-fg mx-0.5 inline-flex rounded border px-1 font-sans text-xs"
          >
            {part.length} spaces
          </span>
        ) : (
          part
        )
      )}
    </>
  );
}

function Value({
  label,
  value,
  command = false,
}: {
  label: string;
  value: string;
  command?: boolean;
}) {
  return (
    <div className="min-w-0 @[30rem]/hook-card:grid @[30rem]/hook-card:grid-cols-[5rem_minmax(0,1fr)] @[30rem]/hook-card:gap-3">
      <dt className="text-muted-foreground mb-0.5 text-xs">{label}</dt>
      <dd className="text-foreground min-w-0 font-mono text-xs [overflow-wrap:anywhere] whitespace-pre-wrap">
        {command ? <HookCommand value={value} /> : value}
      </dd>
    </div>
  );
}

/** All values come from the stored detail, including full paths and fingerprints. */
export function HookDisclosure({
  disclosure,
}: {
  disclosure: NonNullable<ReturnType<typeof readHookDisclosure>>;
}) {
  return (
    <div data-slot="approval-detail" className="space-y-3">
      {disclosure.hooks.map((hook, index) => (
        <section key={index} data-slot="hook-block" className="bg-muted/60 min-w-0 rounded-lg p-3">
          <h4 className="text-foreground mb-3 text-sm font-medium">{hookWhen(hook.event)}</h4>
          <dl className="space-y-3">
            <Value label="Event" value={hook.event} />
            <Value label="Runs in" value={disclosure.directory} />
            <Value label="Command" value={hook.command} command />
            <Value label="Matches" value={hook.matcher} />
          </dl>
        </section>
      ))}
      {disclosure.files.length > 0 && (
        <section className="bg-muted/60 min-w-0 rounded-lg p-3">
          <h4 className="text-foreground mb-3 text-sm font-medium">Files these hooks run</h4>
          <dl className="space-y-3">
            {disclosure.files.map((file, index) => (
              <div key={index} className="space-y-1">
                <Value label="File" value={file.file} />
                <Value label="Fingerprint" value={file.hash} />
              </div>
            ))}
          </dl>
        </section>
      )}
      <p className="text-foreground text-xs">
        Files these commands load can change without asking again.
      </p>
    </div>
  );
}
