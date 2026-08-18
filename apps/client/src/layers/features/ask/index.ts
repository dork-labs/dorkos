/**
 * The Ask — one prompt an agent is parked on, answerable from anywhere.
 *
 * A tool approval, a question and an MCP elicitation are one object to whoever
 * is being asked, so they are one card family here. It is drawn on five
 * surfaces: the header tray, the sidebar's Heads up rows, the home triage
 * header, a room's live lane, and inline in the session that raised it. Answer
 * it once and it resolves everywhere, because every copy reads the same
 * fleet-wide list (`entities/attention`) and the same resolution event.
 *
 * `features/approvals` keeps its own object — a capability approval is
 * persisted, ULID-keyed and lives for hours — and borrows this slice's chrome so
 * the two look like one product without their data being merged.
 *
 * @module features/ask
 */
export { AskCard, askUrgency, WARN_AT_S, URGENT_AT_S } from './ui/AskCard';
export type { AskCardReceiptTone, AskUrgency } from './ui/AskCard';
export { AskList } from './ui/AskList';
export { AskStack } from './ui/AskStack';
export { InteractionAsk } from './ui/InteractionAsk';
export { AskReceiptLine } from './ui/AskReceiptLine';

// The three prompts the transcript renders inline. They moved here from
// `features/chat/ui/tools/` with the rest of the family; the session's message
// renderer composes them, which is UI composition across features.
export { ApprovalPrompt } from './ui/ApprovalPrompt';
export type { ApprovalPromptHandle } from './ui/ApprovalPrompt';
export { QuestionPrompt } from './ui/QuestionPrompt';
export type { QuestionPromptHandle } from './ui/QuestionPrompt';
export { ElicitationPrompt } from './ui/ElicitationPrompt';
export { AskReceipt } from './ui/AskReceipt';
export { AskReceiptRow } from './ui/AskReceiptRow';
export { QuestionAnswerSummary, QuestionUnansweredRow } from './ui/QuestionAnswerSummary';

export { useAnswerAsk } from './model/use-answer-ask';
export { useAskShortcut } from './model/use-ask-shortcut';
export { requestAskTray, useAskTrayRequest } from './model/ask-tray-store';
export { askExitTransition, RESOLVE_HOLD_S, MELT_S } from './model/ask-exit-transition';
export { askHeadline, agentNameFromCwd } from './lib/ask-headline';
export { groupAsks } from './lib/group-asks';
export type { AskGroup } from './lib/group-asks';
export { formatTimeLeft, formatAskTimeLeft } from './lib/format-time-left';
