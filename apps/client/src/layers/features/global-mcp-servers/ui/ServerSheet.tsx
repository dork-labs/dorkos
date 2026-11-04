import type { ReactNode } from 'react';
import { Lock, TriangleAlert } from 'lucide-react';
import {
  isUnpinnedPackage,
  type GlobalMcpServerField,
  type GlobalMcpServerView,
} from '@dorkos/shared/global-mcp-schemas';
import { usePatchGlobalMcpServer } from '@/layers/entities/global-mcp';
import {
  Button,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/layers/shared/ui';
import {
  changeError,
  fieldLine,
  unencryptedSecretHeaders,
  wasNotConfirmed,
} from '../lib/server-lines';
import { ServerMark } from './ServerMark';
import { WhichAgents } from './WhichAgents';

interface ServerSheetProps {
  /** The server, as the list last read it. */
  server: GlobalMcpServerView;
  /** Close the sheet. */
  onClose: () => void;
  /** Ask to remove the server. */
  onRemove: () => void;
  /** Where focus goes when the sheet closes. */
  onCloseAutoFocus: (event: Event) => void;
}

/** "Oct 22": when a person added it, the date alone. */
function addedOn(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * One server: what runs, secrets masked; who gets it; Remove server. There is no Edit, on
 * purpose: to change a server, remove it and add it again, which types its secret again. Switches
 * apply as they are pressed, so "Confirm it's you" runs at the switch and Done only closes.
 */
export function ServerSheet({ server, onClose, onRemove, onCloseAutoFocus }: ServerSheetProps) {
  const patch = usePatchGlobalMcpServer();
  const unpinned =
    server.command !== undefined && isUnpinnedPackage(server.command, server.args ?? []);
  const clearHeaders = unencryptedSecretHeaders(server);

  return (
    <ResponsiveDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <ResponsiveDialogContent
        className="max-h-[85vh]"
        desktopProps={{ className: 'min-h-0 sm:max-w-lg' }}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <ResponsiveDialogHeader>
          <div className="flex items-center gap-3">
            <ServerMark />
            <div className="min-w-0 text-left">
              <ResponsiveDialogTitle className="truncate">{server.name}</ResponsiveDialogTitle>
              <ResponsiveDialogDescription>
                Added {addedOn(server.addedAt)}
              </ResponsiveDialogDescription>
            </div>
          </div>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody alignWithHeader className="space-y-4 py-1">
          <dl className="bg-muted grid gap-x-4 gap-y-1.5 rounded-lg p-3 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
            {server.command !== undefined && <Line term="Command">{server.command}</Line>}
            {server.args !== undefined && server.args.length > 0 && (
              <Line term="Arguments">{server.args.join(' ')}</Line>
            )}
            {server.url !== undefined && <Line term="URL">{server.url}</Line>}
            {server.transport === 'sse' && <Line term="Transport">SSE</Line>}
            {server.env.length > 0 && (
              <Line term="Environment">
                {server.env.map((field) => (
                  <FieldLine key={field.name} field={field} />
                ))}
              </Line>
            )}
            {server.headers.length > 0 && (
              <Line term="Headers">
                {server.headers.map((field) => (
                  <FieldLine key={field.name} field={field} />
                ))}
              </Line>
            )}
          </dl>

          {unpinned && (
            <p className="text-muted-foreground text-sm">
              Not pinned to a version. What runs can change later.
            </p>
          )}
          {clearHeaders.map((name) => (
            <p key={name} className="flex items-start gap-1.5 text-sm">
              <TriangleAlert
                className="text-status-warning-dot mt-0.5 size-(--size-icon-sm) shrink-0"
                aria-hidden
              />
              <span>
                This address isn’t encrypted, so <strong className="font-medium">{name}</strong>{' '}
                travels in the clear.
              </span>
            </p>
          ))}
          {server.skippedOn.length > 0 && (
            <p className="text-status-warning-fg text-sm">
              Not available to Codex or OpenCode agents
            </p>
          )}
          {server.warnings.map((warning) => (
            <p key={`${warning.name}:${warning.note}`} className="text-status-warning-fg text-sm">
              {warning.note}
            </p>
          ))}

          <WhichAgents
            excluded={server.excludedAgents}
            disabled={patch.isPending}
            onChange={(excludedAgents) =>
              patch.mutate({ name: server.name, patch: { excludedAgents } })
            }
          />
          {patch.isError &&
            (wasNotConfirmed(patch.error) ? (
              <p role="status" className="text-sm">
                Not confirmed. Nothing changed.
              </p>
            ) : (
              <p role="alert" className="text-destructive text-sm">
                {changeError(patch.error)}
              </p>
            ))}
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter className="shrink-0 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            className="max-sm:h-11"
            disabled={patch.isPending}
            onClick={onRemove}
          >
            Remove server
          </Button>
          <Button type="button" className="max-sm:h-11" onClick={onClose}>
            Done
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/** One env var or header: a secret wears the lock, and anything else is just its name. */
function FieldLine({ field }: { field: GlobalMcpServerField }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="min-w-0 break-all">{fieldLine(field)}</span>
      {field.secret && <Lock className="size-(--size-icon-xs) shrink-0" aria-hidden />}
    </span>
  );
}

/** One term of the mono block. */
function Line({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0 font-mono break-words">{children}</dd>
    </>
  );
}
