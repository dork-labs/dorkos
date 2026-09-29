import {
  serviceName as toolkitServiceName,
  useConnectorAgentRequest,
} from '@/layers/entities/connectors';
import {
  QueryErrorState,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  Skeleton,
} from '@/layers/shared/ui';
import { AgentRequestCard } from './agent-request/AgentRequestCard';

/**
 * One agent's request to use an app, opened from the page's "Needs you" strip
 * or a `?request=` link. It is the chat's own card in a dialog (DOR-2503): the
 * person answers a request one way wherever they meet it, at the level the
 * agent asked for, with the same words and the same record afterwards.
 */
export function AgentRequestDialog({
  requestId,
  open,
  onOpenChange,
  onEditExactActions,
  onCloseAutoFocus,
}: {
  /** The request to show. */
  requestId: string | null;
  /** Whether the dialog is open. */
  open: boolean;
  /** Close the dialog. */
  onOpenChange: (open: boolean) => void;
  /** Open the exact per-action editor for an account the agent already holds exact actions on. */
  onEditExactActions?: (connectionId: string) => void;
  /**
   * Where focus goes once the dialog closes. The opener can be gone by then
   * (an answered request leaves the "Needs you" strip), so the page decides.
   */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const request = useConnectorAgentRequest(requestId);
  const title = request.data
    ? `${request.data.agent.displayName} asked to use ${toolkitServiceName(request.data.serviceSlug)}`
    : 'An agent’s request';

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        data-testid="agent-request-dialog"
        onCloseAutoFocus={onCloseAutoFocus}
        className="max-h-[90vh] sm:max-w-xl"
      >
        {/* The card carries its own visible question; the dialog's name is for assistive tech. */}
        <ResponsiveDialogHeader className="sr-only">
          <ResponsiveDialogTitle>{title}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Answer it here the same way you would in the chat.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="pb-4">
          {request.isPending ? (
            <Skeleton className="h-40 rounded-xl" aria-label="Loading the request" />
          ) : request.isError ? (
            <QueryErrorState
              title="Couldn’t load this request"
              description="Nothing changed. Try again."
              onRetry={() => void request.refetch()}
              isRetrying={request.isFetching}
            />
          ) : request.data ? (
            <AgentRequestCard
              key={request.data.requestId}
              request={request.data}
              className="max-w-none"
              {...(onEditExactActions ? { onEditExactActions } : {})}
            />
          ) : null}
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
