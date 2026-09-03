/**
 * One runtime's settings card, wired to live data.
 *
 * {@link RuntimeCardView} is the whole of the card's appearance and none of its
 * behaviour; this is the other half. It is the only component in the family that
 * touches a hook, which is what keeps the view, the rows and the summary builder
 * renderable from the dev playground without a server (design §7).
 *
 * Three things about the wiring are load-bearing:
 *
 * - **The model catalog is fetched late.** A runtime's catalog is a real
 *   round-trip, and a tab with three cards on it would otherwise make three of
 *   them before anybody had asked a question. So the query runs only when the
 *   runtime is ready AND the card is open or has a model whose name the summary
 *   needs. Until then the summary says the raw model id, which is honest interim
 *   truth (spec, open question 2).
 * - **A runtime with no config section OFFERS nothing, and says so.** Where a
 *   setting lives is something the runtime declares (`settings.configSection`);
 *   a card for a runtime that declares none invents no key nobody can read back
 *   — and, because a control whose write falls on the floor is worse than no
 *   control, it draws one line instead of the three rows. Trust is the same
 *   story: `useTrustStopWrites` also needs a declared section, so it too would
 *   go nowhere. While that declaration is still in flight the rows are drawn but
 *   DISABLED, because the same writes fall on the floor in that window too.
 * - **Trust is not written here.** The tab holds the single `useTrustStopWrites`
 *   call and the single autonomy dialog for every card, because consent is one
 *   contract with the server and two of them would drift. This card reports the
 *   change and is told the answer.
 *
 * @module features/settings/ui/runtimes/RuntimeCard
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, Check, Loader2 } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { EffortLevel } from '@dorkos/shared/types';
import type {
  DependencyCheck,
  PermissionStop,
  RuntimeReadiness as RuntimeConnectState,
} from '@dorkos/shared/agent-runtime';
import { runtimeAuthConnectKind, runtimeDisplayName } from '@dorkos/shared/agent-runtime';
import { claudeAccountName, cn } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { Badge, Button, InlineCode } from '@/layers/shared/ui';
import { configKeys, useConfig, useUpdateConfig } from '@/layers/entities/config';
import {
  CommandTransparencyNote,
  DependencyInstallHint,
  PRIMARY_RUNTIME_TYPES,
  getRuntimeDescriptor,
  selectRuntimeReadiness,
  selectExpiringSignIn,
  settingsForRuntime,
  useProvisionRuntime,
  useRuntimeCapabilities,
  useRuntimeReadiness,
  useRuntimeRequirements,
} from '@/layers/entities/runtime';
import { modelsQueryOptions } from '@/layers/entities/session';
// UI composition across sibling features, which the layer rule allows: there is
// exactly one connect flow and one power-source wording in the product, and this
// card injects them rather than growing second copies that would drift.
import { describePowerSource, renderRuntimeConnect } from '@/layers/features/runtime-connect';
import { RuntimeCardView } from './RuntimeCardView';
import { buildRuntimeCardSummary } from './RuntimeCardSummary';
import { renderRuntimeSettingsSection } from './section-registry';

/** What the tab tells one card, and the two things the card asks it to do. */
export interface RuntimeCardProps {
  /** Runtime type id, e.g. `'codex'`. */
  type: string;
  /** Whether new conversations start on this runtime. */
  isDefault: boolean;
  /**
   * This runtime's stored trust override, or `null` when it follows the global
   * setting. Never a copy of the global value — see {@link RuntimeCardProps.globalStop}.
   */
  trustStop: PermissionStop | null;
  /** The stop the global row resolves to, which `null` above inherits. */
  globalStop: PermissionStop;
  /**
   * Set or clear this runtime's override. The tab writes it, because a change to
   * Full autonomy has to pass through the one consent dialog the tab owns.
   */
  onChangeTrustStop: (stop: PermissionStop | null) => void;
  /**
   * Make this runtime the one new conversations start on. Also the tab's write:
   * `runtimes.default` is a single setting that every card can change, and one
   * writer for it means two cards clicked in quick succession cannot race.
   */
  onMakeDefault: () => void;
}

/**
 * What a reopened connect flow is called on a card that is already connected.
 *
 * The trigger's own word lives in `RuntimeCardHeader` (it is a rendering
 * decision, and the header draws the trigger); this map carries the two things
 * the header cannot: the cancel wording, and the panel's test-id namespace,
 * which is the one the setup dialog has always used for the same two flows.
 */
const RECONNECT_FLOWS = {
  login: { id: 'reconnect', cancelLabel: 'Keep current sign-in' },
  'provider-picker': { id: 'change', cancelLabel: 'Keep current source' },
} as const;

/** A ready runtime's way back into its connect flow. */
interface CardReconnect {
  /** Which flow reopens: a sign-in, or OpenCode's source picker. */
  kind: keyof typeof RECONNECT_FLOWS;
  /** Connect descriptor handed to the injected flow. */
  connect: NonNullable<RuntimeConnectState['connect']>;
  /** Current provider id, for the picker's "Currently: …" label. */
  currentProvider?: string;
}

/**
 * What a ready runtime can reopen, or `null` when there is nothing honest to.
 *
 * `Ready` is a fingerprint check — it cannot see a stale key or an expired host
 * login — so a connected runtime keeps a small way to redo it. OpenCode with no
 * DorkOS provider on record has nothing for the picker to change FROM, and a
 * runtime outside the three we know how to sign in to would get a flow that
 * cannot work; both answer `null` rather than a misleading affordance.
 *
 * @param type - Runtime type id.
 * @param provider - The provider `GET /api/system/requirements` reports, if any.
 */
function selectReconnect(type: string, provider: string | undefined): CardReconnect | null {
  if (runtimeAuthConnectKind(type) === 'provider-picker') {
    if (!provider) return null;
    return {
      kind: 'provider-picker',
      connect: { kind: 'provider-picker', label: 'Change power source' },
      currentProvider: provider,
    };
  }
  if (!(PRIMARY_RUNTIME_TYPES as readonly string[]).includes(type)) return null;
  return {
    kind: 'login',
    connect: { kind: 'login', label: `Reconnect ${runtimeDisplayName(type)}` },
  };
}

/** Turn a failed config write into one sentence a person can act on. */
function describeWriteFailure(err: unknown): string {
  return (err instanceof Error && err.message) || 'Could not save that. Try again.';
}

/**
 * One runtime card: its settings, its connection, and every write either makes.
 *
 * @param props - See {@link RuntimeCardProps}.
 */
export function RuntimeCard({
  type,
  isDefault,
  trustStop,
  globalStop,
  onChangeTrustStop,
  onMakeDefault,
}: RuntimeCardProps) {
  const { data: config } = useConfig();
  const { data: capabilityMap } = useRuntimeCapabilities();
  const { data: requirements } = useRuntimeRequirements();
  const { registered } = useRuntimeReadiness(type);
  const updateConfig = useUpdateConfig();
  const queryClient = useQueryClient();
  const transport = useTransport();

  // Per card, deliberately: cards expand independently, and opening one never
  // closes another (design §4).
  const [expanded, setExpanded] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  // The server's own projection, not this hook's `ready`: the requirements
  // payload carries a derived `state`/`connect` pair that owns the honest CTA,
  // and every other connect surface reads it through this selector.
  const readiness = selectRuntimeReadiness(requirements, type, registered);
  const ready = readiness.state === 'ready';

  const descriptor = getRuntimeDescriptor(type);
  const settings = settingsForRuntime(capabilityMap, type);
  const defaults = config?.executionDefaults?.perRuntime.find((e) => e.runtime === type);
  const configuredModel = defaults?.model ?? null;
  const requirementsEntry = requirements?.runtimes[type];
  // Null nearly always: only a credential that reports a real deadline, close
  // enough to act on, says anything here.
  const expiringSignIn = selectExpiringSignIn(requirements, type);

  // Late, and only when there is a question to answer: an open card offers a
  // model picker, and a collapsed one with a model set needs the catalog to name
  // it. Neither is true of a closed, unconfigured, or not-yet-connected card.
  const { data: models } = useQuery({
    ...modelsQueryOptions(transport, { runtime: type }),
    enabled: ready && (expanded || configuredModel !== null),
  });

  /**
   * Persist one change under `runtimes`.
   *
   * Invalidates the `configKeys.all` PREFIX, not this card's key: the status
   * bar, the sidebar badges and `useFeatureEnabled` read config off a broader
   * key set, and the server applies these live, so every reader has to move
   * with the write. The key comes from the entity's factory rather than a
   * literal, so every writer on this tab spells the prefix one way.
   */
  function write(patch: Record<string, unknown>) {
    setWriteError(null);
    updateConfig.mutate(
      { runtimes: patch },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: configKeys.all });
          setChanged(true);
        },
        onError: (err) => setWriteError(describeWriteFailure(err)),
      }
    );
  }

  /**
   * Whether this runtime has anywhere to keep the card's three standing rows.
   *
   * A declaration that has not arrived is not evidence against, so an unknown
   * `settings` reads as yes — the same permissive rule `supportsEffort` follows
   * below. Only a runtime that has actually said `configSection: null` gets the
   * one-line card.
   */
  const storesDefaults = settings ? settings.configSection !== null : true;

  /**
   * Whether the runtime has said where its settings live yet.
   *
   * Until it has, {@link writeForRuntime} and `useTrustStopWrites` both resolve
   * the section to `undefined` and do nothing — so the rows keep their permissive
   * appearance ({@link storesDefaults} above) but arrive DISABLED, rather than
   * looking live for the length of one round-trip and swallowing the change
   * somebody made in it. They enable the moment the declaration lands.
   */
  const writesPending = settings === undefined;

  /**
   * Persist a change into the leaf this runtime declared for its settings.
   *
   * A runtime with no declared section returns early. Inventing a key from its
   * type would write config the server never reads back, which is worse than
   * doing nothing: the control would look like it worked. That early return is
   * the backstop, not the whole answer — {@link storesDefaults} is what keeps
   * such a control off the card in the first place.
   */
  function writeForRuntime(patch: Record<string, unknown>) {
    const section = settings?.configSection;
    if (!section) return;
    write({ [section]: patch });
  }

  // The stop a new session on this runtime actually starts at, and whether that
  // came from this card or from the row beneath the cards.
  const effectiveStop = trustStop ?? globalStop;

  // Each declared section's one summary value. Resolution belongs here (the
  // container has the config); the wording belongs to the summary builder.
  const claudeCode = config?.claudeCode;
  const sectionValues: Record<string, string | null> = {
    'claude-accounts':
      !claudeCode || claudeCode.inherited || !claudeCode.resolvedAccount
        ? // The inherited default is not a billing choice anybody made, so the
          // line stays quiet rather than naming a folder as if it were one.
          null
        : claudeAccountName(claudeCode.resolvedAccount, claudeCode.accounts ?? []),
    'opencode-power-source': requirementsEntry?.provider
      ? describePowerSource(requirementsEntry.provider)
      : null,
  };

  // The catalog entry for the model a new conversation would start on, resolved
  // once: the Effort row reads it to decide what it may offer, and the summary
  // reads the same answer so the collapsed line cannot promise an effort the
  // opened card calls stranded.
  const selectedModel = configuredModel
    ? (models ?? []).find((model) => model.value === configuredModel)
    : undefined;

  const summary = buildRuntimeCardSummary({
    ready,
    settings,
    model: configuredModel,
    models,
    effort: defaults?.effort,
    modelTakesEffort: selectedModel ? (selectedModel.supportsEffort ?? false) : undefined,
    trustStop: effectiveStop,
    trustInherited: trustStop === null,
    sectionValues,
  });

  const installDep = requirementsEntry?.dependencies.find(
    (dep) => dep.status !== 'satisfied' && dep.installHint
  );
  const installCommand = installDep?.installHint ?? descriptor.setup?.installCommand;
  const installInfoUrl = installDep?.infoUrl ?? descriptor.setup?.infoUrl;

  const connectSlot =
    !ready && readiness.connect ? (
      <div data-testid={`runtime-card-connect-${type}`}>
        {readiness.connect.kind === 'install' ? (
          <ProvisionConnect
            type={type}
            label={readiness.connect.label}
            installCommand={installCommand}
            installInfoUrl={installInfoUrl}
          />
        ) : (
          renderRuntimeConnect({ type, connect: readiness.connect })
        )}
      </div>
    ) : null;

  const reconnect = ready ? selectReconnect(type, requirementsEntry?.provider) : null;
  // A requirements refetch that drops this runtime out of ready closes the panel
  // with it, so a later return to ready shows the settled header rather than a
  // flow that opened itself.
  if (!reconnect && reconnecting) setReconnecting(false);
  const flow = reconnect ? RECONNECT_FLOWS[reconnect.kind] : null;

  const reconnectPanel =
    reconnect && flow && reconnecting ? (
      <div className="space-y-2" data-testid={`runtime-${flow.id}-panel-${type}`}>
        {renderRuntimeConnect({
          type,
          connect: reconnect.connect,
          ...(reconnect.currentProvider ? { currentProvider: reconnect.currentProvider } : {}),
          // Collapse the instant the connect lands: the flow's own confirmation
          // takes over, and the refreshed requirements say the rest.
          onConnected: () => setReconnecting(false),
        })}
        <button
          type="button"
          onClick={() => setReconnecting(false)}
          className="focus-ring text-muted-foreground hover:text-foreground rounded-sm text-xs transition-colors"
          data-testid={`runtime-${flow.id}-cancel-${type}`}
        >
          {flow.cancelLabel}
        </button>
      </div>
    ) : null;

  const setupDetails = requirementsEntry ? (
    requirementsEntry.dependencies.map((dep) => <SetupDependencyRow key={dep.name} dep={dep} />)
  ) : descriptor.setup ? (
    <>
      <p className="text-muted-foreground text-xs">
        Not registered with this server. Install it, then enable{' '}
        <InlineCode>runtimes.{type}</InlineCode> in your DorkOS config.
      </p>
      <DependencyInstallHint
        command={descriptor.setup.installCommand}
        infoUrl={descriptor.setup.infoUrl}
        copyLabel={`Copy install command for ${descriptor.label}`}
      />
    </>
  ) : undefined;

  // What the closed "Setup details" disclosure is hiding, said on its own
  // trigger — this app's rule for every collapsed settings group
  // (`contributing/design-system.md` §Disclosure). A missing/outdated check is
  // the thing worth naming; a fully satisfied list just says how many there
  // are.
  const unsatisfiedDeps = requirementsEntry?.dependencies.filter(
    (dep) => dep.status !== 'satisfied'
  );
  const setupBadge = requirementsEntry ? (
    <Badge
      variant="secondary"
      className={cn('text-xs', unsatisfiedDeps?.length ? 'text-amber-600 dark:text-amber-400' : '')}
    >
      {unsatisfiedDeps?.length
        ? `${unsatisfiedDeps.length} missing`
        : `${requirementsEntry.dependencies.length} ${requirementsEntry.dependencies.length === 1 ? 'check' : 'checks'}`}
    </Badge>
  ) : undefined;

  return (
    // The card view is props-only and has no slot for what a WRITE has to say,
    // so the two lines that follow a write sit directly beneath it, aligned to
    // its padding. They are the card's own voice, not another card's: both are
    // scoped by runtime type.
    <div className="flex flex-col gap-1.5">
      <RuntimeCardView
        type={type}
        {...(descriptor.subtitle ? { subtitle: descriptor.subtitle } : {})}
        ready={ready}
        isDefault={isDefault}
        onMakeDefault={onMakeDefault}
        expanded={expanded}
        onToggleExpanded={() => setExpanded((open) => !open)}
        summary={summary}
        {...(expiringSignIn ? { expiringSignIn } : {})}
        connectSlot={connectSlot}
        {...(reconnect && !reconnecting
          ? { reconnect: { kind: reconnect.kind, onOpen: () => setReconnecting(true) } }
          : {})}
        reconnectPanel={reconnectPanel}
        model={{
          models,
          value: configuredModel,
          onChange: (value) => writeForRuntime({ defaultModel: value }),
          disabled: writesPending,
        }}
        effort={{
          // Both answers the row needs, from the two places that hold them: the
          // runtime says whether it has an effort setting at all, and the chosen
          // model says whether it takes one. A declaration that has not arrived is
          // not evidence against — a row that called effort unsupported for the
          // length of one round-trip would be lying.
          supportsEffort: settings?.supportsEffort ?? true,
          selectedModel,
          configuredModelId: configuredModel,
          value: defaults?.effort ?? null,
          onChange: (value: EffortLevel | null) => writeForRuntime({ defaultEffort: value }),
          disabled: writesPending,
        }}
        trust={{
          descriptors: capabilityMap?.capabilities[type]?.permissionModes?.values ?? [],
          stop: trustStop,
          globalStop,
          onChange: onChangeTrustStop,
          disabled: writesPending,
        }}
        storesDefaults={storesDefaults}
        sections={settings?.sections}
        renderSection={(kind) => renderRuntimeSettingsSection(kind, { type })}
        setupDetails={setupDetails}
        setupBadge={setupBadge}
      />

      {/* Only after something has actually changed (progressive disclosure):
          before then there is nothing to reassure anybody about. */}
      {changed && (
        <p
          className="text-muted-foreground px-4 text-xs"
          data-testid={`runtime-card-timing-${type}`}
        >
          Applies to new conversations — running ones keep their settings.
        </p>
      )}

      {writeError && (
        <p
          className="text-destructive flex items-start gap-1.5 px-4 text-xs"
          data-testid={`runtime-card-error-${type}`}
        >
          <CircleAlert className="mt-px size-3 shrink-0" aria-hidden />
          <span>{writeError}</span>
        </p>
      )}
    </div>
  );
}

/**
 * One-click Connect for a runtime whose connect action is an install (ADR-0317).
 *
 * A small local composition rather than a reused component: the entity's own
 * provision button is private to its setup panel, and the pieces that matter —
 * the hook, the manual fallback hint, the transparency note that always names
 * the exact command — are the exported ones this uses.
 */
function ProvisionConnect({
  type,
  label,
  installCommand,
  installInfoUrl,
}: {
  type: string;
  label: string;
  installCommand?: string;
  installInfoUrl?: string;
}) {
  const descriptor = getRuntimeDescriptor(type);
  const reducedMotion = useReducedMotion();
  const { provision, isPending, isError, errorMessage, progress, result } =
    useProvisionRuntime(type);

  // While installing — or after a successful result, until the card flips to
  // ready — show progress instead of a re-clickable button.
  if (isPending || result?.ok) {
    const message = progress?.message ?? `Installing ${descriptor.label}…`;
    return (
      <motion.div
        className="bg-muted flex items-center gap-2 rounded-lg px-3 py-2.5"
        initial={reducedMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        data-testid="provision-progress"
      >
        {/* CSS spin, not a motion rotate: a repeated animate-to-360 stalls after
            the first turn on re-render (DOR-439). */}
        <Loader2
          className={cn(
            'text-muted-foreground size-3.5 shrink-0',
            !reducedMotion && 'animate-spin'
          )}
        />
        <AnimatePresence mode="wait">
          <motion.span
            key={message}
            className="truncate text-xs"
            initial={reducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reducedMotion ? undefined : { opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {message}
          </motion.span>
        </AnimatePresence>
      </motion.div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-2">
        <p className="text-destructive text-xs" role="alert">
          {errorMessage}
        </p>
        {/* Never a dead end: a runtime whose server has no provision endpoint
            still leaves the person a command they can run themselves. */}
        {installCommand && (
          <>
            <p className="text-muted-foreground text-xs">You can install it yourself instead:</p>
            <DependencyInstallHint
              command={installCommand}
              infoUrl={installInfoUrl}
              copyLabel={`Copy install command for ${descriptor.label}`}
            />
          </>
        )}
        <Button size="sm" onClick={provision}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div>
      <Button size="sm" onClick={provision}>
        {label}
      </Button>
      {installCommand && (
        <CommandTransparencyNote command={installCommand} runtimeLabel={descriptor.label} />
      )}
    </div>
  );
}

/**
 * A single dependency check inside the Setup details disclosure: status, name,
 * and a copyable install/auth command when unsatisfied.
 *
 * The Priya-facing detail — CLI and binary vocabulary lives here and nowhere on
 * the default path. Local for the same reason {@link ProvisionConnect} is: the
 * entity's row is private to its setup panel, while the hint block beneath it is
 * exported and shared.
 */
function SetupDependencyRow({ dep }: { dep: DependencyCheck }) {
  const satisfied = dep.status === 'satisfied';
  return (
    <div className="space-y-2" data-testid="runtime-setup-dependency">
      {/* Stacked, not inline: the name owns its line so a long label never wraps
          beside a truncating description. */}
      {/* Two columns rather than a hand-measured indent: the description sits in
          the name's column, so it lines up under the name whatever the icon's
          size — the `pl-[1.375rem]` this replaced was 14px of icon plus 8px of
          gap, written out as a number that silently broke if either moved. */}
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-2">
        {satisfied ? (
          <Check className="size-3.5 shrink-0 text-emerald-500" />
        ) : (
          <CircleAlert className="size-3.5 shrink-0 text-amber-500" />
        )}
        <span className="text-sm">{dep.name}</span>
        <p className="text-muted-foreground col-start-2 mt-1 text-xs">
          {satisfied && dep.version ? `v${dep.version}` : dep.description}
        </p>
      </div>
      {!satisfied && (dep.installHint || dep.infoUrl) && (
        <DependencyInstallHint
          command={dep.installHint}
          infoUrl={dep.infoUrl}
          copyLabel={`Copy install command for ${dep.name}`}
        />
      )}
    </div>
  );
}
