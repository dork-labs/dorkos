import { Button } from '@/layers/shared/ui';
import { McpSigninBody, type McpSigninFlow } from '@/layers/entities/agent';

/** Props for {@link McpSigninPanel}. */
export interface McpSigninPanelProps {
  /** The sign-in state machine for this server. */
  flow: McpSigninFlow;
  /** The server's name, for the link's accessible label and the custody copy. */
  serverName: string;
}

/**
 * The inline OAuth sign-in surface on a managed server card.
 *
 * The surface itself — the custody disclosure in its trust panel, the link, the
 * waiting note, the terminal states — is {@link McpSigninBody}, shared with the
 * card an agent draws in a conversation so the consent copy cannot drift between
 * the two, and so the custody statement is made exactly ONCE in both.
 *
 * That last part is why the trust treatment is not here. It was briefly added as
 * a panel ABOVE `McpSigninBody`, which left two stacked paragraphs saying nearly
 * the same thing in two different boxes — the duplicate-disclosure pattern
 * DOR-1004 removed from the agent's prose for exactly this reason. The trust
 * treatment now wraps the server's own sentence inside `McpSigninBody`, and this
 * component adds only what belongs to a settings card: the buttons that let a
 * person retry, cancel, or clear a finished flow.
 */
export function McpSigninPanel({ flow, serverName }: McpSigninPanelProps) {
  return (
    <>
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
