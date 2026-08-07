import { Button } from '@/layers/shared/ui';
import { McpSigninBody, type McpSigninFlow } from '@/layers/entities/agent';

/** Props for {@link McpSigninPanel}. */
export interface McpSigninPanelProps {
  /** The sign-in state machine for this server. */
  flow: McpSigninFlow;
  /** The server's name, for the link's accessible label. */
  serverName: string;
}

/**
 * The inline OAuth sign-in surface under a managed row.
 *
 * The surface itself — disclosure, link, waiting note, terminal states — is
 * {@link McpSigninBody}, shared with the card an agent draws in a conversation
 * so the consent copy cannot drift between the two. This adds only what belongs
 * to a settings row: the indent under the row, and the buttons that let a person
 * retry or clear a finished flow.
 */
export function McpSigninPanel({ flow, serverName }: McpSigninPanelProps) {
  return (
    <McpSigninBody
      flow={flow}
      serverName={serverName}
      className="pl-4"
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
  );
}
