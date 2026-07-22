/**
 * The scripted DorkBot onboarding conversation (ADR 260722-111314).
 *
 * DorkBot arrives (first light), then speaks a fixed script built from the real
 * chat components: message bubbles, a typing indicator, inline personality and
 * discovery widgets, and — at the final beat — a live composer. The user's first
 * real message dissolves the overlay into a real session (ADR 260722-111316).
 * Every DorkBot line here is client-generated; no tokens are spent until the
 * user sends that first message.
 *
 * @module features/onboarding/ui/OnboardingConversation
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { useNavigate } from '@tanstack/react-router';
import { DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import type { Traits } from '@dorkos/shared/mesh-schemas';
import { DORKBOT_ONBOARDING_LINES } from '@dorkos/shared/dorkbot-templates';
import { useAgentBirthStore, type AgentBirthRecord } from '@/layers/shared/model';
import { fireCelebration } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';
import { MessageItem, TypingDots, ChatInput, FirstLight } from '@/layers/features/chat';
import { PersonalityPicker } from '@/layers/features/agent-hub';
import { resolveDefaultAgentDir } from '@/layers/entities/config';
import { useUpdateAgent } from '@/layers/entities/agent';
import { useOnboarding } from '../model/use-onboarding';
import {
  useOnboardingConversation,
  type OnboardingConversationPorts,
} from '../model/use-onboarding-conversation';
import { ConversationDiscoveryBeat } from './ConversationDiscoveryBeat';

/** How long the first-light arrival lingers before DorkBot speaks (ms). */
const FIRST_LIGHT_MS = 1500;

/** Props for {@link OnboardingConversation}. */
export interface OnboardingConversationProps {
  /** Called on dissolve — hides the overlay for the session (set by the app shell). */
  onComplete: () => void;
}

/**
 * The full onboarding conversation surface.
 *
 * @param props - The dissolve callback wired by the app shell.
 */
export function OnboardingConversation({ onComplete }: OnboardingConversationProps) {
  const reducedMotion = useReducedMotion() ?? false;
  const navigate = useNavigate();
  const { config, completeStep, skipStep, completeOnboarding } = useOnboarding();
  const updateAgent = useUpdateAgent();

  const [traits, setTraits] = useState<Traits>({ ...DEFAULT_TRAITS });
  const [composerValue, setComposerValue] = useState('');

  const defaultAgentPath = resolveDefaultAgentDir(config);
  const traitsSavePath = `${config?.agents?.defaultDirectory || '~/.dork/agents'}/dorkbot`;

  const ports: OnboardingConversationPorts = {
    reducedMotion,
    saveTraits: (next) =>
      updateAgent.mutateAsync({ path: traitsSavePath, updates: { traits: next } }).then(() => {}),
    completeStep,
    skipStep,
    completeOnboarding,
    onDissolve: (text) => {
      const newSessionId = crypto.randomUUID();
      const record: Omit<AgentBirthRecord, 'fired'> = {
        kind: 'first-message',
        name: 'dorkbot',
        displayName: 'DorkBot',
        agentId: 'dorkbot',
        bornAt: new Date().toISOString(),
        path: defaultAgentPath,
        runtime: 'claude-code',
        kickoffMessage: text,
      };
      useAgentBirthStore.getState().register(newSessionId, record);
      void fireCelebration();
      navigate({ to: '/session', search: { dir: defaultAgentPath, session: newSessionId } });
      onComplete();
    },
  };

  const convo = useOnboardingConversation(ports);

  // First light lingers, then DorkBot begins. Reduced motion starts at once.
  const { beginConversation } = convo;
  useEffect(() => {
    const t = setTimeout(beginConversation, reducedMotion ? 0 : FIRST_LIGHT_MS);
    return () => clearTimeout(t);
  }, [beginConversation, reducedMotion]);

  // Keep the newest message and the typing indicator in view.
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: reducedMotion ? 'auto' : 'smooth' });
  }, [convo.messages.length, convo.isTyping, convo.activeWidget, reducedMotion]);

  const handlePersonalityChange = useCallback(
    (next: Traits) => {
      setTraits(next);
      convo.selectPersonality(next);
    },
    [convo]
  );

  const handleSubmitFirstMessage = useCallback(() => {
    const text = composerValue.trim();
    if (!text) return;
    convo.submitFirstMessage(text);
  }, [composerValue, convo]);

  const { fastForward } = convo;
  const handleAreaKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fastForward();
      }
    },
    [fastForward]
  );

  const dorkbotArrival = useMemo<AgentBirthRecord>(
    () => ({
      name: 'dorkbot',
      displayName: 'DorkBot',
      agentId: 'dorkbot',
      bornAt: new Date().toISOString(),
      path: defaultAgentPath,
      runtime: 'claude-code',
      kickoffMessage: '',
      fired: false,
    }),
    [defaultAgentPath]
  );

  if (convo.isFirstLight) {
    return (
      <div className="flex h-full w-full items-center justify-center p-4">
        <FirstLight record={dorkbotArrival} />
      </div>
    );
  }

  const composerPlaceholder = convo.composerEnabled
    ? DORKBOT_ONBOARDING_LINES.composerHandoffPlaceholder
    : DORKBOT_ONBOARDING_LINES.composerSetupPlaceholder;

  let confirmLabel = "That's the one";
  if (convo.saving) {
    confirmLabel = 'Saving…';
  } else if (convo.saveError) {
    confirmLabel = 'Try again';
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col">
      {/* Message area: tap/click or press Enter to fast-forward the reveal.
          Lines auto-reveal without any interaction; this is just an accelerator. */}
      <div
        className="min-h-0 flex-1 cursor-default overflow-y-auto px-2 py-4"
        role="button"
        tabIndex={0}
        aria-label="Reveal the rest of the message"
        onClick={fastForward}
        onKeyDown={handleAreaKeyDown}
      >
        <div className="flex flex-col gap-1" aria-live="polite" aria-atomic="false">
          {convo.messages.map((message, i) => (
            <MessageItem
              key={message.id}
              message={message}
              grouping={convo.grouping[i]}
              sessionId=""
            />
          ))}
          {convo.isTyping && (
            <div className="px-1 py-2">
              <TypingDots />
            </div>
          )}
        </div>

        {/* Inline widgets, revealed once the beat's lines have landed. */}
        {convo.activeWidget === 'personality' && (
          <div className="mt-3 flex flex-col items-stretch gap-3 px-1">
            <PersonalityPicker
              traits={traits}
              onTraitsChange={handlePersonalityChange}
              compact
              sampleLabel="How DorkBot will talk"
            />
            {convo.saveError && (
              <p
                className="text-destructive text-sm"
                role="alert"
                data-testid="personality-save-error"
              >
                {DORKBOT_ONBOARDING_LINES.saveError}
              </p>
            )}
            <div className="flex justify-start">
              <Button
                size="sm"
                onClick={() => convo.confirmPersonality(traits)}
                disabled={convo.saving}
                data-testid="confirm-personality"
              >
                {confirmLabel}
              </Button>
            </div>
          </div>
        )}

        {convo.activeWidget === 'discovery' && (
          <div className="mt-3 px-1">
            <ConversationDiscoveryBeat
              phase={convo.discoveryPhase}
              onConsent={convo.consentDiscovery}
              onDecline={convo.declineDiscovery}
              onResults={convo.reportDiscoveryResults}
              onZero={convo.reportDiscoveryZero}
              onTimeout={convo.reportDiscoveryTimeout}
              onDone={convo.finishDiscovery}
            />
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Composer: a disabled stand-in until Beat 3, then the real ChatInput. */}
      <div className="shrink-0 px-2 pb-3">
        {convo.composerEnabled ? (
          <>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {['Show me around', 'Help me set up a project', 'Just exploring for now'].map(
                (hint) => (
                  <Button
                    key={hint}
                    size="xs"
                    variant="outline"
                    onClick={() => setComposerValue(hint)}
                  >
                    {hint}
                  </Button>
                )
              )}
            </div>
            <ChatInput
              value={composerValue}
              onChange={setComposerValue}
              onSubmit={handleSubmitFirstMessage}
              isStreaming={false}
              placeholder={composerPlaceholder}
            />
          </>
        ) : (
          <div
            className="border-input bg-muted/40 text-muted-foreground flex items-center rounded-md border px-3 py-2.5 text-sm"
            aria-disabled="true"
          >
            {composerPlaceholder}
          </div>
        )}
      </div>
    </div>
  );
}
