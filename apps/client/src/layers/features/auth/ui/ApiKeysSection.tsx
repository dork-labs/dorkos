import { useId, useState } from 'react';
import { Check, Copy, KeyRound, Trash2 } from 'lucide-react';
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
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@/layers/shared/ui';
import { useCopyFeedback } from '@/layers/shared/lib';
import { useApiKeys, useCreateApiKey, useRevokeApiKey } from '../model/use-api-keys';
import type { ApiKeyRecord, CreatedApiKey } from '../model/auth-client';

/** Expiry presets (seconds) for a new key; `null` = never expires. */
const EXPIRY_OPTIONS: { label: string; value: string; seconds: number | null }[] = [
  { label: 'Never', value: 'never', seconds: null },
  { label: '7 days', value: '7d', seconds: 60 * 60 * 24 * 7 },
  { label: '30 days', value: '30d', seconds: 60 * 60 * 24 * 30 },
  { label: '90 days', value: '90d', seconds: 60 * 60 * 24 * 90 },
];

/**
 * Per-user API key management — create, one-time reveal, and revoke scoped keys
 * for MCP / scripts / agents. Rendered inside the Security section only when
 * login is enabled. The plaintext key is shown exactly once at creation.
 */
export function ApiKeysSection() {
  const nameId = useId();
  const { data: keys, isLoading } = useApiKeys();
  const create = useCreateApiKey();
  const revoke = useRevokeApiKey();

  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState('never');
  const [created, setCreated] = useState<CreatedApiKey | null>(null);

  async function handleCreate() {
    const seconds = EXPIRY_OPTIONS.find((o) => o.value === expiry)?.seconds ?? null;
    const result = await create.run(name, seconds);
    if (result) {
      setCreated(result);
      setName('');
      setExpiry('never');
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <KeyRound className="text-muted-foreground size-4" />
          <p className="text-sm font-medium">API keys</p>
        </div>
        <p className="text-muted-foreground text-xs">
          Personal keys for MCP clients, scripts, and agents. Pass a key as a{' '}
          <code className="font-mono">Bearer</code> token. The value is shown once at creation.
        </p>
      </div>

      {created ? (
        <CreatedKeyReveal created={created} onDone={() => setCreated(null)} />
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-40 flex-1 space-y-1.5">
            <Label htmlFor={nameId}>Name</Label>
            <Input
              id={nameId}
              placeholder="e.g. laptop-cli"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="w-32 space-y-1.5">
            <Label>Expires</Label>
            <Select value={expiry} onValueChange={setExpiry}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXPIRY_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={handleCreate} disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create key'}
          </Button>
        </div>
      )}

      {create.error && (
        <p className="text-xs text-red-500" role="alert">
          {create.error.message}
        </p>
      )}

      <div className="space-y-1.5">
        {isLoading ? (
          <Skeleton className="h-9 w-full" />
        ) : keys && keys.length > 0 ? (
          keys.map((key) => (
            <ApiKeyRow
              key={key.id}
              apiKey={key}
              revoking={revoke.pendingId === key.id}
              onRevoke={() => revoke.run(key.id)}
            />
          ))
        ) : (
          <p className="text-muted-foreground text-xs">No API keys yet.</p>
        )}
      </div>

      {revoke.error && (
        <p className="text-xs text-red-500" role="alert">
          {revoke.error.message}
        </p>
      )}
    </div>
  );
}

/** One-time plaintext reveal for a freshly created key. */
function CreatedKeyReveal({ created, onDone }: { created: CreatedApiKey; onDone: () => void }) {
  const [copied, copy] = useCopyFeedback();
  return (
    <div className="border-primary/40 bg-primary/5 space-y-3 rounded-lg border p-3">
      <p className="text-sm font-medium">Copy your key now — it won&apos;t be shown again</p>
      <div className="flex items-center gap-2">
        <code className="bg-muted min-w-0 flex-1 truncate rounded-md px-3 py-2 font-mono text-xs">
          {created.key}
        </code>
        <button
          className="text-muted-foreground hover:text-foreground shrink-0 rounded-sm p-1.5 transition-colors"
          onClick={() => copy(created.key)}
          aria-label="Copy API key"
        >
          {copied ? <Check className="size-4 text-green-500" /> : <Copy className="size-4" />}
        </button>
      </div>
      <Button variant="outline" size="sm" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}

/** A single existing key row with a confirmed revoke action. */
function ApiKeyRow({
  apiKey,
  revoking,
  onRevoke,
}: {
  apiKey: ApiKeyRecord;
  revoking: boolean;
  onRevoke: () => void;
}) {
  const label = apiKey.name || 'Unnamed key';
  const hint = apiKey.start ? `${apiKey.start}…` : apiKey.prefix || '';
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{label}</p>
        <p className="text-muted-foreground font-mono text-xs">
          {hint}
          {apiKey.expiresAt
            ? ` · expires ${new Date(apiKey.expiresAt).toLocaleDateString()}`
            : ' · no expiry'}
        </p>
      </div>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="sm" disabled={revoking} aria-label={`Revoke ${label}`}>
            <Trash2 className="size-3.5" />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this API key?</AlertDialogTitle>
            <AlertDialogDescription>
              Anything using “{label}” will immediately lose access. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onRevoke}>Revoke</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
