import { ShieldCheck } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { McpSigninBody, type McpSigninFlow } from '@/layers/entities/agent';

/** Props for {@link McpSigninPanel}. */
export interface McpSigninPanelProps {
  /** The sign-in state machine for this server. */
  flow: McpSigninFlow;
  /** The server's name, for the link's accessible label and the trust copy. */
  serverName: string;
}

/**
 * The reassurance a person needs at the exact moment they are deciding whether
 * to hand an account over.
 *
 * It sits above the server-composed disclosure rather than replacing it: the
 * disclosure is the consent text and stays verbatim and focused. This says the
 * one thing the disclosure's careful wording does not say loudly enough — the
 * key never leaves this computer, and it is reversible.
 *
 * The reversal it promises is REMOVING THE SERVER, which is the only one that
 * exists: `forgetServer` runs on removal, and there is no sign-out route yet
 * (spec `mcp-server-cards-redesign` §7). An earlier draft said "you can sign out
 * anytime" beside a menu that deliberately has no Sign out in it. Restore the
 * stronger wording when the route lands, not before.
 *
 * @param props.serverName - The provider whose site the person will approve on.
 */
function SignInTrustPanel({ serverName }: { serverName: string }) {
  return (
    <div className="border-status-success-border bg-status-success-bg text-status-success-fg mt-2 flex items-start gap-2 rounded-md border px-3 py-2">
      <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p className="text-xs leading-relaxed">
        <strong className="font-semibold">Your sign-in stays on this computer.</strong> You approve
        access on {serverName}&rsquo;s own site. DorkOS keeps the resulting key here — the agent
        never sees it, and removing the server removes the key.
      </p>
    </div>
  );
}

/**
 * The inline OAuth sign-in surface on a managed server card.
 *
 * The surface itself — disclosure, link, waiting note, terminal states — is
 * {@link McpSigninBody}, shared with the card an agent draws in a conversation
 * so the consent copy cannot drift between the two. This adds what belongs to
 * the settings card: the trust panel above the disclosure, and the buttons that
 * let a person retry or clear a finished flow.
 */
export function McpSigninPanel({ flow, serverName }: McpSigninPanelProps) {
  return (
    <>
      {flow.state.step === 'disclosure' && <SignInTrustPanel serverName={serverName} />}
      <McpSigninBody
        flow={flow}
        serverName={serverName}
        failedActions={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => flow.start()}
              className="focus-visible:ring-2"
            >
              Try again
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => flow.reset()}
              className="focus-visible:ring-2"
            >
              Dismiss
            </Button>
          </>
        }
        connectedActions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => flow.reset()}
            className="focus-visible:ring-2"
          >
            Dismiss
          </Button>
        }
      />
      {(flow.state.step === 'disclosure' || flow.state.step === 'waiting') && (
        <div className="mt-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => flow.reset()}
            aria-label={`Cancel signing in to ${serverName}`}
            className="focus-visible:ring-2"
          >
            Cancel
          </Button>
        </div>
      )}
    </>
  );
}
