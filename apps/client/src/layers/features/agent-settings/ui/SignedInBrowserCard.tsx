import { useCallback, useState } from 'react';
import { Globe, ShieldAlert } from 'lucide-react';
import { Button, CopyButton, FieldCard, FieldCardContent } from '@/layers/shared/ui';
import { useAddAgentMcpServer, useAgentBrowserPreset } from '@/layers/entities/agent';
import type { AgentBrowserPreset } from '@dorkos/shared/agent-browser';
import type { AddAgentMcpServerInput, CapabilityApprovalRequired } from '@dorkos/shared/transport';

interface SignedInBrowserCardProps {
  /** ULID of the agent the browser is given to. */
  agentId: string;
  /** Display label for the agent, used in the confirmation copy. */
  agentLabel: string;
}

/** The server entry the preset hands to `mcp.add`. */
function addInput(agentId: string, preset: AgentBrowserPreset): AddAgentMcpServerInput {
  return { agentId, name: preset.server.name, connection: preset.server.connection };
}

/** "github.com, linear.app and 3 more" — names only, the way a person scans them. */
function siteList(preset: AgentBrowserPreset): string {
  const live = preset.sites.filter((site) => !site.expired).map((site) => site.site);
  if (live.length <= 3) return live.join(', ');
  return `${live.slice(0, 3).join(', ')} and ${live.length - 3} more`;
}

/**
 * The one-step way to give an agent the signed-in browser (spec
 * `agent-browser-sessions`): a Playwright browser that starts signed in to the
 * sites the operator saved with `dorkos browser login`, without the agent ever
 * seeing a password.
 *
 * It adds nothing new to trust: the button feeds the preset server to the same
 * `mcp.add` the Add form uses, so the write still waits on the confirmation
 * that shows the exact command. The parent hides this card once the agent has
 * the browser.
 */
export function SignedInBrowserCard({ agentId, agentLabel }: SignedInBrowserCardProps) {
  const preset = useAgentBrowserPreset();
  const addServer = useAddAgentMcpServer();
  const [pending, setPending] = useState<CapabilityApprovalRequired | null>(null);
  const [error, setError] = useState<string | null>(null);

  const add = useCallback(
    async (approval?: CapabilityApprovalRequired) => {
      if (!preset.data) return;
      setError(null);
      try {
        const result = await addServer.mutateAsync({
          input: addInput(agentId, preset.data),
          ...(approval ? { approval } : {}),
        });
        if (result.status !== 'approval_required') setPending(null);
        else if (approval) setError('The browser still needs approval. Try again.');
        else setPending(result.approval);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Couldn’t add the browser.');
      }
    },
    [addServer, agentId, preset.data]
  );

  if (!preset.data) return null;
  const data = preset.data;
  const sites = siteList(data);
  const loginHint = `${data.loginCommand} <site>`;

  return (
    <FieldCard>
      <FieldCardContent className="space-y-3">
        <div className="flex items-start gap-2">
          {pending ? (
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
          ) : (
            <Globe className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          )}
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium">
              {pending ? `Confirm the signed-in browser for ${agentLabel}` : 'Signed-in browser'}
            </p>
            <p className="text-muted-foreground text-xs">
              {pending
                ? 'This command runs on your machine whenever the agent starts a session. Each session gets its own browser, so agents working at the same time never share one.'
                : 'A web browser that starts signed in to the sites you saved. The agent never sees your passwords.'}
            </p>
            {data.saved ? (
              <p className="text-xs">Signed in to {sites}.</p>
            ) : (
              <p className="text-xs text-amber-600 dark:text-amber-500">
                No sign-ins saved yet, so it starts signed out. Run{' '}
                <code className="font-mono">{loginHint}</code>
                <CopyButton
                  value={loginHint}
                  label="Copy the sign-in command"
                  size="xs"
                  className="mx-0.5 inline-flex align-middle"
                />{' '}
                in a terminal first.
              </p>
            )}
          </div>
        </div>

        {pending && (
          <pre className="bg-muted text-foreground overflow-x-auto rounded-md px-3 py-2 font-mono text-xs">
            {[data.server.connection.command, ...data.server.connection.args].join(' ')}
          </pre>
        )}

        {error && <p className="text-destructive text-xs">{error}</p>}

        <div className="flex justify-end gap-2">
          {pending && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPending(null)}
              disabled={addServer.isPending}
              className="focus-visible:ring-2"
            >
              Back
            </Button>
          )}
          <Button
            variant={pending ? 'default' : 'outline'}
            size="sm"
            onClick={() => void add(pending ?? undefined)}
            disabled={addServer.isPending}
            className="focus-visible:ring-2"
          >
            {addServer.isPending ? 'Adding…' : pending ? 'Confirm & add' : 'Give it the browser'}
          </Button>
        </div>
      </FieldCardContent>
    </FieldCard>
  );
}
