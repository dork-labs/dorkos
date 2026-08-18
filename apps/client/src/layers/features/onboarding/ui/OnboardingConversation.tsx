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
import { useAgentBirthStore, useAppStore, type AgentBirthRecord } from '@/layers/shared/model';
import { fireCelebration, resolveAgentVisual } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';
import { ConversationRoot } from '@/layers/features/conversation';
import { NARRATION_CAPABILITIES } from '../model/narration-capabilities';
import {
  SessionMessage,
  TypingDots,
  FirstLight,
  resolveMessageAuthor,
  type MessageAuthorAgent,
} from '@/layers/features/chat';
import { Composer } from '@/layers/features/composer';
import { useDefaultAgentSession } from '@/layers/entities/config';
import { PersonalityPicker, useUpdateAgent, useResolvedAgents } from '@/layers/entities/agent';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { useRuntimeRequirements, selectRuntimeReadiness } from '@/layers/entities/runtime';
import { chooseDefaultRuntime } from '../model/use-onboarding-runtime-default';
import { useOnboarding } from '../model/use-onboarding';
import { useProfile } from '../model/use-profile';
import {
  useOnboardingConversation,
  type OnboardingConversationPorts,
} from '../model/use-onboarding-conversation';
import { ConversationDiscoveryBeat } from './ConversationDiscoveryBeat';
import { OnboardingWidgetCard } from './OnboardingWidgetCard';
import { ProfileRolePicker } from './ProfileRolePicker';

/** How long the first-light arrival lingers before DorkBot speaks (ms). */
const FIRST_LIGHT_MS = 1500;

/** How long the dissolve celebration runs before it is force-stopped. */
const CELEBRATION_MAX_MS = 4000;

/**
 * DorkBot's slug — the identity key its lines group under before the registry
 * has named the system agent, and the `name` on every birth record here.
 */
const DORKBOT_SLUG = 'dorkbot';

/** What every scripted line in this conversation calls the speaker. */
const DORKBOT_NAME = 'DorkBot';

/**
 * The disc colour DorkBot's surfaces wear until the registry names the system
 * agent — and the reason is the whole point of this screen's identity work.
 *
 * DorkBot's manifest id is a ULID and its manifest carries neither colour nor
 * icon, so its entire face is hashed from that id. The only id available before
 * the registry answers is the slug, which hashes to a face DorkBot wears in no
 * other surface — and which would visibly swap the moment the real one lands.
 *
 * **Deliberate for BOTH ways this screen can lack a face**, and they are named
 * where they are computed: the queries still *pending*, and the queries
 * *settled with an error*. A confident-but-wrong face is equally wrong whether
 * the answer is late or never coming, so both take this placeholder. There is
 * no retry: a face is not worth a second request, and the surfaces beneath stay
 * fully usable without one.
 *
 * A theme token rather than a colour literal, which the two consumers survive
 * differently and on purpose:
 *
 * - `MessageAuthorAvatar` cannot contrast-check a `var()`, so it steps its disc
 *   back to `tint` and draws the initial.
 * - `AgentAvatar` (first light) has no such step and fills with it outright.
 *   That is safe: `readableForeground` treats a colour it cannot parse as a
 *   dark background and returns its near-white foreground, and
 *   {@link PENDING_IDENTITY_EMOJI} leaves no glyph to read anyway.
 */
const PENDING_IDENTITY_COLOR = 'var(--color-muted-foreground)';

/**
 * The emoji a pending face carries: none.
 *
 * Explicitly empty rather than omitted, because `resolveAgentVisual` HASHES an
 * emoji from the id whenever `icon` is absent — so omitting it is exactly what
 * would put a slug-hashed face on first light, the defect this all exists to
 * remove. `??` preserves an empty string, so this passes through that resolver
 * untouched and the disc falls back to no glyph at all.
 */
const PENDING_IDENTITY_EMOJI = '';

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
  // The default agent's REGISTERED absolute path — the registry is the only
  // thing that proves DorkBot is where the path says it is. Used for the
  // session directory ONLY; the face below comes from somewhere stricter.
  const { defaultAgentDir } = useDefaultAgentSession();

  // DorkBot is the SYSTEM agent, and `isSystem` on the manifest is the only
  // thing on the wire that says so — the same lookup the sidebar makes
  // (`SidebarChrome`), and deliberately NOT "whichever agent is configured as
  // the default". Those coincide on a fresh install but an install is free to
  // point the default elsewhere, and this screen's script is DorkBot's
  // specifically: its name is written into every line and its traits are saved
  // to the dorkbot directory. A face from a different agent would contradict
  // the words beside it.
  const { data: meshData } = useMeshAgentPaths();
  const agentPaths = useMemo(
    () => (meshData?.agents ?? []).map((entry) => entry.projectPath),
    [meshData]
  );
  const { data: manifests } = useResolvedAgents(agentPaths);

  // One face, read by every surface on this screen, so first light and the
  // message gutter cannot resolve differently. `null` covers both no-face
  // branches named on {@link PENDING_IDENTITY_COLOR}: still PENDING (either
  // query out, or the system agent not yet in the answer) and SETTLED-ERROR
  // (a query failed, leaving no manifests to search). Both take the
  // placeholder, deliberately.
  const dorkbotFace = useMemo(() => {
    const manifest = agentPaths.map((path) => manifests?.[path]).find((m) => m?.isSystem === true);
    if (!manifest) return null;
    const { color, emoji } = resolveAgentVisual(manifest);
    return { id: manifest.id, color, emoji };
  }, [agentPaths, manifests]);
  // The runtime the first session will ACTUALLY start on. It was written here as
  // the literal `'claude-code'` twice, which was true only until somebody set a
  // different default — and then the birth certificate named a runtime the
  // session was not running on. Read off the same `GET /api/config` this screen
  // already has in hand, which is also what the Settings card writes to, so the
  // two can never disagree and this adds no second request.
  const defaultRuntime = config?.executionDefaults?.runtime ?? 'claude-code';

  // …but the FIRST session has to actually start. The default may point at a
  // runtime this machine has not connected — the setup step deliberately lets a
  // person choose one they are about to install — and onboarding ends by sending
  // a message, not by offering the choice again. So this one session falls back
  // to something that is ready, while the person's default stays exactly as they
  // set it and takes effect the moment that runtime is connected.
  //
  // A requirements answer nobody has is never evidence against: while the query
  // is still out, the configured default is used unchanged.
  const { data: requirements } = useRuntimeRequirements();
  const firstSessionRuntime = useMemo(() => {
    if (!requirements) return defaultRuntime;
    const ready = Object.keys(requirements.runtimes).filter(
      (type) => selectRuntimeReadiness(requirements, type, true).state === 'ready'
    );
    if (ready.length === 0 || ready.includes(defaultRuntime)) return defaultRuntime;
    return chooseDefaultRuntime(ready, defaultRuntime) ?? defaultRuntime;
  }, [requirements, defaultRuntime]);

  const [traits, setTraits] = useState<Traits>({ ...DEFAULT_TRAITS });
  const [profileRoles, setProfileRoles] = useState<string[]>([]);
  const { saveRoles } = useProfile();
  const [composerValue, setComposerValue] = useState('');
  // One-way latch so a double Enter during the exit never double-dissolves.
  const dissolvedRef = useRef(false);

  // Composed from the directory the SERVER reports, with no fallback: this path
  // is a write target (`PATCH /api/agents/current?path=…`), and guessing
  // `~/.dork/agents` wrote DorkBot's traits into the operator's real home from a
  // dev tree, where the data directory is somewhere else entirely (DOR-662).
  const agentsDirectory = config?.agents?.defaultDirectory;
  const traitsSavePath = agentsDirectory ? `${agentsDirectory}/dorkbot` : null;

  const ports: OnboardingConversationPorts = {
    reducedMotion,
    saveTraits: (next) =>
      traitsSavePath
        ? updateAgent
            .mutateAsync({ path: traitsSavePath, updates: { traits: next } })
            .then(() => {})
        : // Rejecting lands on the conversation's existing save-error beat, which
          // offers a retry — the right outcome for "we do not know where DorkBot
          // lives yet", and strictly better than writing somewhere we guessed.
          Promise.reject(new Error('DorkBot’s location is still loading — try again in a moment.')),
    // The same deep-merge write path as tours: PATCH { profile: { roles } }.
    saveProfile: (roles) => saveRoles(roles),
    completeStep,
    skipStep,
    completeOnboarding,
    onDissolve: (text) => {
      const newSessionId = crypto.randomUUID();
      const record: Omit<AgentBirthRecord, 'fired'> = {
        kind: 'first-message',
        name: DORKBOT_SLUG,
        displayName: DORKBOT_NAME,
        // The same face the conversation drew from, so the mark beside the
        // user's first real turn is the one they just spent three screens
        // talking to.
        agentId: dorkbotFace?.id ?? DORKBOT_SLUG,
        icon: dorkbotFace?.emoji ?? PENDING_IDENTITY_EMOJI,
        color: dorkbotFace?.color ?? PENDING_IDENTITY_COLOR,
        bornAt: new Date().toISOString(),
        path: defaultAgentDir,
        // The certificate says what this session RUNS on, so it names the same
        // runtime the session is launched with.
        runtime: firstSessionRuntime,
        kickoffMessage: text,
      };
      useAgentBirthStore.getState().register(newSessionId, record);
      // Bounded celebration: capture the engine's cleanup and force-stop it after
      // a few seconds so the confetti never rains on across the new session.
      void fireCelebration().then((stop) => {
        setTimeout(stop, CELEBRATION_MAX_MS);
      });
      // `runtime` is the launch-time selection the first message POST carries as
      // its binding hint — the lever that makes the fallback above real rather
      // than cosmetic, since the server would otherwise resolve this session
      // from the manifest and the configured default.
      navigate({
        to: '/session',
        search: { dir: defaultAgentDir, session: newSessionId, runtime: firstSessionRuntime },
      });
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

  const handleSubmitFirstMessage = useCallback(() => {
    const text = composerValue.trim();
    if (!text || dissolvedRef.current) return;
    dissolvedRef.current = true;
    convo.submitFirstMessage(text);
  }, [composerValue, convo]);

  const requestTour = useAppStore((s) => s.requestTour);
  // "Show me around" ends onboarding and hands off to the general tour instead of
  // starting a session: finish the flow, then request the tour (the tour host,
  // mounted app-wide, deep-links home and spotlights the dashboard).
  const handleShowMeAround = useCallback(() => {
    if (dissolvedRef.current) return;
    dissolvedRef.current = true;
    completeOnboarding();
    requestTour('general');
    onComplete();
  }, [completeOnboarding, requestTour, onComplete]);

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

  // Fast-forward affordance, applied atomically only while lines are revealing —
  // once a widget (picker, chips, cards) is shown these drop, so the button role
  // never wraps interactive content. Lines auto-reveal regardless of this.
  const fastForwardProps = convo.isRevealing
    ? {
        role: 'button' as const,
        tabIndex: 0,
        'aria-label': 'Reveal the rest of the message',
        onClick: fastForward,
        onKeyDown: handleAreaKeyDown,
      }
    : {};

  // DorkBot speaks every scripted line, so the list's identity gutter wears the
  // face the sidebar will show. No emoji while the face is unresolved: the
  // avatar then draws the initial over the neutral disc, which reads as "still
  // loading" rather than as somebody else.
  const dorkbotAuthor = useMemo<MessageAuthorAgent>(
    () =>
      dorkbotFace
        ? {
            id: dorkbotFace.id,
            displayName: DORKBOT_NAME,
            emoji: dorkbotFace.emoji,
            color: dorkbotFace.color,
          }
        : { id: DORKBOT_SLUG, displayName: DORKBOT_NAME, color: PENDING_IDENTITY_COLOR },
    [dorkbotFace]
  );

  // First light draws the same face at 48px. It reads the record's `icon` and
  // `color` as OVERRIDES and hashes from `agentId` for anything missing, which
  // is why the pending branch supplies both explicitly rather than omitting
  // them — see {@link PENDING_IDENTITY_EMOJI}.
  const dorkbotArrival = useMemo<AgentBirthRecord>(
    () => ({
      name: DORKBOT_SLUG,
      displayName: DORKBOT_NAME,
      agentId: dorkbotFace?.id ?? DORKBOT_SLUG,
      icon: dorkbotFace?.emoji ?? PENDING_IDENTITY_EMOJI,
      color: dorkbotFace?.color ?? PENDING_IDENTITY_COLOR,
      bornAt: new Date().toISOString(),
      path: defaultAgentDir,
      runtime: defaultRuntime,
      kickoffMessage: '',
      fired: false,
    }),
    [dorkbotFace, defaultAgentDir, defaultRuntime]
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

  let profileConfirmLabel = "That's us";
  if (convo.saving) {
    profileConfirmLabel = 'Saving…';
  } else if (convo.saveError) {
    profileConfirmLabel = 'Try again';
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col">
      {/* Message area: while lines are still revealing, tap/click or press Enter
          to fast-forward (see fastForwardProps). */}
      <div
        className="min-h-0 flex-1 cursor-default overflow-y-auto px-2 py-4"
        {...fastForwardProps}
      >
        <div className="flex flex-col gap-1" aria-live="polite" aria-atomic="false">
          {/* A story told in message rows. It declares its own conversation
              because the row reads what the surface can do, and the honest
              answer here is nothing. */}
          <ConversationRoot surface="session" capabilities={NARRATION_CAPABILITIES}>
            {convo.messages.map((message, i) => (
              <SessionMessage
                key={message.id}
                message={message}
                grouping={convo.grouping[i]}
                author={resolveMessageAuthor(message, { agent: dorkbotAuthor })}
                sessionId=""
                presentation
              />
            ))}
          </ConversationRoot>
          {convo.isTyping && (
            <div className="px-1 py-2">
              <TypingDots />
            </div>
          )}
        </div>

        {/* Inline widgets, revealed once the beat's lines have landed. Each sits
            in a card so it reads as an interactive control, not more chat text. */}
        {convo.activeWidget === 'personality' && (
          <div className="mt-3 px-1">
            <OnboardingWidgetCard>
              <div className="flex flex-col items-stretch gap-3">
                <PersonalityPicker
                  traits={traits}
                  onTraitsChange={setTraits}
                  layout="stacked"
                  sampleLabel="How DorkBot talks"
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
                <div className="flex flex-wrap justify-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => convo.confirmPersonality(traits)}
                    disabled={convo.saving}
                    data-testid="confirm-personality"
                  >
                    {confirmLabel}
                  </Button>
                  {/* Per-beat skip, mirroring the discovery beat's "Not now":
                      moves on one beat without saving traits. Disabled while a
                      save is in flight so both paths can't advance at once. */}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={convo.skipPersonality}
                    disabled={convo.saving}
                    data-testid="skip-personality"
                  >
                    Skip this step
                  </Button>
                </div>
              </div>
            </OnboardingWidgetCard>
          </div>
        )}

        {convo.activeWidget === 'profile' && (
          <div className="mt-3 px-1">
            <OnboardingWidgetCard>
              <ProfileRolePicker
                selected={profileRoles}
                onChange={setProfileRoles}
                onConfirm={() => convo.confirmProfile(profileRoles)}
                confirmLabel={profileConfirmLabel}
                onSkip={convo.skipProfile}
                skipLabel="Skip this"
                busy={convo.saving}
                error={convo.saveError ? DORKBOT_ONBOARDING_LINES.saveError : null}
              />
            </OnboardingWidgetCard>
          </div>
        )}

        {convo.activeWidget === 'discovery' && (
          <div className="mt-3 px-1">
            <OnboardingWidgetCard>
              <ConversationDiscoveryBeat
                phase={convo.discoveryPhase}
                onConsent={convo.consentDiscovery}
                onDecline={convo.declineDiscovery}
                onResults={convo.reportDiscoveryResults}
                onZero={convo.reportDiscoveryZero}
                onTimeout={convo.reportDiscoveryTimeout}
                onDone={convo.finishDiscovery}
              />
            </OnboardingWidgetCard>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Composer: a disabled stand-in until Beat 3, then the real Composer.Input. */}
      <div className="shrink-0 px-2 pb-3">
        {convo.composerEnabled ? (
          <>
            <div className="mb-2 flex flex-wrap gap-1.5">
              <Button size="xs" variant="outline" onClick={handleShowMeAround}>
                Show me around
              </Button>
              {['Help me set up a project', 'Just exploring for now'].map((hint) => (
                <Button
                  key={hint}
                  size="xs"
                  variant="outline"
                  onClick={() => setComposerValue(hint)}
                >
                  {hint}
                </Button>
              ))}
            </div>
            <Composer.Input
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
