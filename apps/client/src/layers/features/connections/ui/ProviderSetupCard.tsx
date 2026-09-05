import { useState } from 'react';
import { KeyRound, Trash2 } from 'lucide-react';
import type { ConnectorProviderStatus } from '@dorkos/shared/connector-provider';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  Button,
  Card,
  Label,
  PasswordInput,
} from '@/layers/shared/ui';
import {
  useDeleteConnectorCredential,
  useSaveConnectorCredential,
} from '@/layers/entities/connectors';
import { providerName } from '../lib/presentation';

/**
 * One provider's setup card — the only place on the Connections surface where
 * a vendor name leads. Shows setup state honestly (key entry, registered, or
 * the verbatim refusal error), the provider's custody stance line straight
 * from the server, and key save/delete.
 *
 * @param props - The provider's reference-free status DTO.
 * @param props.status - The provider's status from `GET /api/connectors/providers`.
 */
export function ProviderSetupCard({ status }: { status: ConnectorProviderStatus }) {
  const [secret, setSecret] = useState('');
  const save = useSaveConnectorCredential();
  const remove = useDeleteConnectorCredential();
  const name = providerName(status.type);
  const inputId = `connector-key-${status.type}`;

  const handleSave = () => {
    const trimmed = secret.trim();
    if (!trimmed) return;
    save.mutate({ provider: status.type, secret: trimmed }, { onSuccess: () => setSecret('') });
  };

  return (
    <Card data-testid={`provider-card-${status.type}`} gap="none">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <KeyRound className="text-muted-foreground size-4" aria-hidden />
          {name}
        </h3>
        <ProviderStateBadge status={status} />
      </div>

      {/* The custody stance, server-owned copy — every setup card discloses
          where sign-ins will live BEFORE any key is entered. */}
      <p className="text-muted-foreground mt-2 text-xs leading-relaxed">{status.disclosure}</p>

      {status.error && (
        <p
          role="alert"
          className="text-destructive border-destructive/30 bg-destructive/5 mt-3 rounded-md border px-3 py-2 text-xs leading-relaxed"
        >
          {status.error}
        </p>
      )}

      {status.configured ? (
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs">{savedKeyLine(status.keyKind)}</span>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-destructive gap-1.5 text-xs"
                disabled={remove.isPending}
              >
                <Trash2 className="size-3.5" aria-hidden />
                {remove.isPending ? 'Removing…' : 'Remove key'}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove the {name} key?</AlertDialogTitle>
                <AlertDialogDescription>
                  Services connected through {name} will stop working in your sessions until you add
                  a key again. Your connected accounts are not deleted.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep key</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => remove.mutate({ provider: status.type })}
                  className="bg-destructive hover:bg-destructive/90 text-white"
                >
                  Remove key
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      ) : (
        <form
          className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            handleSave();
          }}
        >
          <div className="min-w-0 flex-1 space-y-1">
            <Label htmlFor={inputId} className="text-xs">
              {name} API key
            </Label>
            <PasswordInput
              id={inputId}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="Paste your key"
              autoComplete="off"
            />
          </div>
          <Button type="submit" size="sm" disabled={!secret.trim() || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save key'}
          </Button>
        </form>
      )}
      {!status.configured && status.type === 'composio' && (
        <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
          Any Composio key works: the project key from your dashboard or the account key the
          composio CLI uses.
        </p>
      )}
    </Card>
  );
}

/** The saved-key line, naming which key kind validated when the server knows. */
function savedKeyLine(keyKind: ConnectorProviderStatus['keyKind']): string {
  if (keyKind === 'user') return 'API key saved, using your account key';
  if (keyKind === 'project') return 'API key saved, using your project key';
  return 'API key saved';
}

/** The honest one-word state of a provider: not set up, key saved, or ready. */
function ProviderStateBadge({ status }: { status: ConnectorProviderStatus }) {
  if (status.registered) {
    return (
      <Badge variant="secondary" tone="success">
        Ready
      </Badge>
    );
  }
  if (status.configured) {
    // Configured but not registered — the refusal error above says why.
    return <Badge variant="destructive">Not running</Badge>;
  }
  return <Badge variant="outline">Not set up</Badge>;
}
