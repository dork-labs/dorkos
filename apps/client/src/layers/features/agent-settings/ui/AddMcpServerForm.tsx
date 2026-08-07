import { useCallback, useMemo, useState } from 'react';
import { Plus, ShieldAlert } from 'lucide-react';
import {
  Button,
  FieldCard,
  FieldCardContent,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Textarea,
} from '@/layers/shared/ui';
import { useAddAgentMcpServer } from '@/layers/entities/agent';
import type { ManagedMcpServer, McpServerTransport } from '@dorkos/shared/mesh-schemas';
import type {
  AddAgentMcpServerInput,
  AgentMcpMutationResult,
  CapabilityApprovalRequired,
} from '@dorkos/shared/transport';
import { AddedServerSignin } from './AddedServerSignin';

/** Every transport kind a managed server can use, across all runtimes. */
export const TRANSPORTS = ['stdio', 'http', 'sse'] as const;
/** A transport kind a managed server can use. */
export type TransportKind = (typeof TRANSPORTS)[number];

/** Server name contract, mirrored from `ManagedMcpServerSchema` for inline validation. */
const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Parse `KEY=VALUE` lines (env / headers) into a record, ignoring blanks. */
function parseKeyValueLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key) out[key] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/** Split a whitespace-separated args string into an argv array. */
function parseArgs(text: string): string[] {
  return text.trim().length ? text.trim().split(/\s+/) : [];
}

interface AddMcpServerFormProps {
  /** ULID of the agent the server is added to. */
  agentId: string;
  /** Display label for the agent, used in the confirmation copy. */
  agentLabel: string;
  /**
   * Transport kinds the agent's runtime can actually use. The form only offers
   * these — a transport the runtime can't run would otherwise be silently
   * dropped at turn time (DOR-892).
   */
  supportedTransports: readonly TransportKind[];
  /**
   * Called once the server is actually written, with what was added. Lets the
   * roster follow up — a remote server is probed straight away, so the operator
   * learns it needs signing in without being asked to press Test (DOR-985).
   */
  onAdded: (server: { name: string; transport: TransportKind }) => void;
  /**
   * A just-added server a probe has since discovered needs an OAuth sign-in, or
   * `null`.
   *
   * The second of two ways this form learns to offer a sign-in, and the slower
   * one. `mcp.add` stamps `authKind` when it can tell at write time; when it
   * cannot, the unattended probe the roster fires a beat later is what finds
   * out, and this carries that answer back so the person is still offered the
   * sign-in where they are standing rather than in a row they have to spot.
   */
  oauthDetectedFor?: string | null;
}

/**
 * Whether the server just written needs an OAuth sign-in, according to the entry
 * that came back.
 *
 * Read from the returned roster rather than assumed from the transport: only the
 * server knows, and it stamps `authKind` at add time when the provider's OAuth
 * discovery answered. A roster that carries no such entry (or no hint) says
 * nothing, and the form resets exactly as it always did.
 */
function addedServerNeedsSignin(result: AgentMcpMutationResult, name: string): boolean {
  if (result.status !== 'ok') return false;
  const entry = result.servers.find((server: ManagedMcpServer) => server.name === name);
  const connection = entry?.connection;
  // Only the remote transports carry the hint; a stdio server has no notion of
  // signing in, so the narrowing is the check.
  return connection !== undefined && 'authKind' in connection && connection.authKind === 'oauth2';
}

/**
 * The "Add server" affordance for managed MCP servers: a transport-aware form
 * that, because `mcp.add` is destructive, resolves through a single operator
 * confirmation showing the exact command/args/url before the write lands. The
 * operator is the approver, so the confirm is a clean yes — not an agent card.
 */
export function AddMcpServerForm({
  agentId,
  agentLabel,
  supportedTransports,
  onAdded,
  oauthDetectedFor = null,
}: AddMcpServerFormProps) {
  const addServer = useAddAgentMcpServer();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [selectedKind, setKind] = useState<TransportKind>(supportedTransports[0] ?? 'stdio');
  // Derived, not synced via effect: if the runtime's supported set no longer
  // includes what's selected (e.g. switching to a Codex agent with `sse`
  // picked), fall back to the first transport it can actually use rather than
  // submitting one that gets silently dropped at turn time (DOR-892).
  const kind = supportedTransports.includes(selectedKind)
    ? selectedKind
    : (supportedTransports[0] ?? 'stdio');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [envText, setEnvText] = useState('');
  const [url, setUrl] = useState('');
  const [headersText, setHeadersText] = useState('');
  const [pending, setPending] = useState<CapabilityApprovalRequired | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The sign-in step, from two sources and one dismissal (DOR-1004). `signinFor`
  // is what the add itself revealed; `oauthDetectedFor` is what the roster's
  // later probe revealed. Both are DERIVED into one answer rather than mirrored
  // into state by an effect, so there is no beat where the form has been told a
  // sign-in is needed and is not yet showing it.
  const [signinFor, setSigninFor] = useState<string | null>(null);
  const [dismissedSignin, setDismissedSignin] = useState<string | null>(null);

  const nameValid = NAME_PATTERN.test(name) && name.length <= 64;
  const connectionValid = kind === 'stdio' ? command.trim().length > 0 : url.trim().length > 0;
  const canSubmit = nameValid && connectionValid && !addServer.isPending;

  const buildConnection = useCallback((): McpServerTransport => {
    if (kind === 'stdio') {
      return {
        transport: 'stdio',
        command: command.trim(),
        args: parseArgs(argsText),
        env: parseKeyValueLines(envText),
      };
    }
    return { transport: kind, url: url.trim(), headers: parseKeyValueLines(headersText) };
  }, [kind, command, argsText, envText, url, headersText]);

  const buildInput = useCallback(
    (): AddAgentMcpServerInput => ({ agentId, name: name.trim(), connection: buildConnection() }),
    [agentId, name, buildConnection]
  );

  const reset = useCallback(() => {
    setOpen(false);
    setPending(null);
    setError(null);
    setName('');
    setKind(supportedTransports[0] ?? 'stdio');
    setCommand('');
    setArgsText('');
    setEnvText('');
    setUrl('');
    setHeadersText('');
  }, [supportedTransports]);

  // Report the write BEFORE `reset()` clears the fields it describes.
  const announceAdded = useCallback(
    (input: AddAgentMcpServerInput) => {
      onAdded({ name: input.name, transport: input.connection.transport });
      reset();
    },
    [onAdded, reset]
  );

  // Report the write, clear the form, and — when the server that landed needs an
  // OAuth sign-in — flow straight into it instead of leaving the person to find
  // the new row and press Sign in (DOR-1004).
  const settleAdded = useCallback(
    (result: AgentMcpMutationResult, input: AddAgentMcpServerInput) => {
      const needsSignin = addedServerNeedsSignin(result, input.name);
      announceAdded(input);
      if (needsSignin) setSigninFor(input.name);
    },
    [announceAdded]
  );

  const submit = useCallback(async () => {
    setError(null);
    const input = buildInput();
    try {
      const result = await addServer.mutateAsync({ input });
      if (result.status === 'approval_required') setPending(result.approval);
      else settleAdded(result, input);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the server.');
    }
  }, [addServer, buildInput, settleAdded]);

  const confirm = useCallback(async () => {
    if (!pending) return;
    setError(null);
    const input = buildInput();
    try {
      const result = await addServer.mutateAsync({ input, approval: pending });
      if (result.status === 'ok') settleAdded(result, input);
      else setError('The server still needs approval. Try again.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the server.');
    }
  }, [addServer, buildInput, pending, settleAdded]);

  const activeSignin =
    signinFor ??
    (oauthDetectedFor && oauthDetectedFor !== dismissedSignin ? oauthDetectedFor : null);

  const dismissSignin = useCallback(() => {
    setDismissedSignin(activeSignin);
    setSigninFor(null);
  }, [activeSignin]);

  const previewCommand = useMemo(
    () => [command.trim(), ...parseArgs(argsText)].filter(Boolean).join(' '),
    [command, argsText]
  );

  if (activeSignin) {
    return <AddedServerSignin agentId={agentId} serverName={activeSignin} onDone={dismissSignin} />;
  }

  if (!open) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="focus-visible:ring-2"
      >
        <Plus className="size-4" />
        Add server
      </Button>
    );
  }

  if (pending) {
    return (
      <FieldCard>
        <FieldCardContent className="space-y-3">
          <div className="flex items-start gap-2">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
            <div className="space-y-1">
              <p className="text-sm font-medium">Confirm this server for {agentLabel}</p>
              <p className="text-muted-foreground text-xs">
                {kind === 'stdio'
                  ? 'This command runs on your machine whenever the agent starts a session.'
                  : 'The agent connects to this URL whenever it starts a session.'}
              </p>
            </div>
          </div>
          <pre className="bg-muted text-foreground overflow-x-auto rounded-md px-3 py-2 font-mono text-xs">
            {kind === 'stdio' ? previewCommand : url.trim()}
          </pre>
          {error && <p className="text-destructive text-xs">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPending(null)}
              disabled={addServer.isPending}
              className="focus-visible:ring-2"
            >
              Back
            </Button>
            <Button
              size="sm"
              onClick={confirm}
              disabled={addServer.isPending}
              className="focus-visible:ring-2"
            >
              {addServer.isPending ? 'Adding…' : 'Confirm & add'}
            </Button>
          </div>
        </FieldCardContent>
      </FieldCard>
    );
  }

  return (
    <FieldCard>
      <FieldCardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="mcp-name">Name</Label>
          <Input
            id="mcp-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-server"
            aria-invalid={name.length > 0 && !nameValid}
          />
          {name.length > 0 && !nameValid && (
            <p className="text-destructive text-xs">Letters, numbers, dashes, underscores only.</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="mcp-transport">Transport</Label>
          <Select value={kind} onValueChange={(v) => setKind(v as TransportKind)}>
            <SelectTrigger id="mcp-transport" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {supportedTransports.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {kind === 'stdio' ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="mcp-command">Command</Label>
              <Input
                id="mcp-command"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npx"
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mcp-args">Arguments</Label>
              <Input
                id="mcp-args"
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                placeholder="-y @modelcontextprotocol/server-filesystem"
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mcp-env">Environment (KEY=VALUE per line)</Label>
              <Textarea
                id="mcp-env"
                value={envText}
                onChange={(e) => setEnvText(e.target.value)}
                placeholder="API_KEY=…"
                rows={2}
                className="font-mono text-xs"
              />
            </div>
          </>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="mcp-url">URL</Label>
              <Input
                id="mcp-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/mcp"
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mcp-headers">Headers (KEY=VALUE per line)</Label>
              <Textarea
                id="mcp-headers"
                value={headersText}
                onChange={(e) => setHeadersText(e.target.value)}
                placeholder="Authorization=Bearer …"
                rows={2}
                className="font-mono text-xs"
              />
            </div>
          </>
        )}

        {error && <p className="text-destructive text-xs">{error}</p>}
        <Separator />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={reset} className="focus-visible:ring-2">
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={!canSubmit} className="focus-visible:ring-2">
            Continue
          </Button>
        </div>
      </FieldCardContent>
    </FieldCard>
  );
}
