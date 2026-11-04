import { useEffect, useRef } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Button } from '@/layers/shared/ui';
import { useNow } from '@/layers/shared/model';
import { AskCard, askExitTransition, formatTimeLeft } from '@/layers/features/ask';
import { useGrantApproval, useDenyApproval } from '../model/use-approval-decision';
import {
  holdDecidedApproval,
  releaseDecidedApproval,
  useRecordedApprovalDecision,
  type ApprovalDecision,
} from '../model/settling-approvals';
import { readHookDisclosure } from '../lib/hook-disclosure';
import { agentLabelFrom } from '../lib/agent-label';
import type { ApprovalCardProps } from './ApprovalCard';
import { RequestingAgent } from './RequestingAgent';
import { HookDisclosure } from './HookDisclosure';

/** Whole hook review: one body scroll, with title/count and answers outside it. */
export function HookApprovalCard({ approval, onDecided, focusOnOpen = true }: ApprovalCardProps) {
  const title = useRef<HTMLHeadingElement>(null);
  const now = useNow(30_000);
  const grant = useGrantApproval();
  const deny = useDenyApproval();
  const reducedMotion = useReducedMotion();
  const decision = useRecordedApprovalDecision(approval.approvalId);
  const disclosure = readHookDisclosure(approval.detail);
  const complete = !approval.cannotAllow && disclosure !== undefined;
  const count = disclosure?.hooks.length;
  const label = approval.packageLabel ?? 'This package';
  const deciding = grant.isPending || deny.isPending;
  useEffect(() => {
    if (!focusOnOpen) return;
    const frame = requestAnimationFrame(() => title.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [focusOnOpen]);
  function answer(kind: ApprovalDecision) {
    onDecided?.(approval.approvalId);
    holdDecidedApproval(approval, kind);
    const onError = () => releaseDecidedApproval(approval.approvalId);
    if (kind === 'denied') deny.mutate({ approvalId: approval.approvalId }, { onError });
    else grant.mutate({ approvalId: approval.approvalId }, { onError });
  }
  const time =
    Date.parse(approval.expiresAt) - now > 365 * 86400000
      ? 'waiting for you'
      : formatTimeLeft(approval.expiresAt, now);
  return (
    <motion.div
      data-approval-id={approval.approvalId}
      className="min-w-0 overflow-hidden"
      exit={{
        opacity: 0,
        height: 0,
        transition: askExitTransition({
          decided: !!decision,
          reducedMotion: reducedMotion === true,
        }),
      }}
    >
      <div
        data-slot="approval-card"
        className="border-border bg-background @container/hook-card flex max-h-[var(--hook-card-max-height,min(42rem,80dvh))] min-w-0 flex-col overflow-hidden rounded-xl border"
      >
        <header className="shrink-0 space-y-1.5 p-4 pb-3">
          <h3
            ref={title}
            tabIndex={-1}
            className="text-foreground focus-visible:ring-ring text-sm leading-snug font-medium [overflow-wrap:anywhere] outline-none focus-visible:ring-2"
          >
            {label} wants to run code on this computer
          </h3>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-1 text-xs">
            {count !== undefined && (
              <>
                <span data-slot="hook-count">
                  {count} {count === 1 ? 'hook' : 'hooks'}
                </span>
                <span aria-hidden>·</span>
              </>
            )}
            {approval.requestedBy ? (
              <span>Asked by {agentLabelFrom(approval.requestedBy)}</span>
            ) : (
              <RequestingAgent
                requestedBy={approval.requestedBy}
                hasAgentPath={approval.hasAgentPath}
                origin={approval.origin}
              />
            )}
            <span aria-hidden>·</span>
            <span className="tabular-nums">{time}</span>
          </div>
        </header>
        {complete ? (
          <div
            role="region"
            aria-label="Hook details"
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users must be able to scroll the full disclosure.
            tabIndex={0}
            className="min-h-0 overflow-y-auto overscroll-contain px-4 pb-3"
          >
            <HookDisclosure disclosure={disclosure} />
          </div>
        ) : (
          <p className="text-muted-foreground px-4 pb-3 text-xs">
            {"This request can't be shown in full, so it can't be allowed yet."}
          </p>
        )}
        <footer className="border-border bg-background shrink-0 border-t p-4 pt-3">
          {decision ? (
            <AskCard.Receipt
              data-slot="approval-resolved"
              tone={decision === 'denied' ? 'denied' : 'allowed'}
            >
              {decision === 'denied' ? 'Not allowed' : 'Allowed once'}
            </AskCard.Receipt>
          ) : (
            <div className="@container/hook-actions">
              <div className="flex flex-col gap-2 @[28rem]/hook-actions:flex-row-reverse">
                {complete && (
                  <Button
                    data-slot="approval-allow"
                    className="min-h-11 flex-1"
                    disabled={deciding}
                    onClick={() => answer('granted')}
                  >
                    {count === 1 ? 'Allow this hook' : `Allow these ${count} hooks`}
                  </Button>
                )}
                <Button
                  data-slot="approval-deny"
                  variant="outline"
                  className="min-h-11 flex-1"
                  disabled={deciding}
                  onClick={() => answer('denied')}
                >
                  Decline
                </Button>
              </div>
            </div>
          )}
        </footer>
      </div>
    </motion.div>
  );
}
