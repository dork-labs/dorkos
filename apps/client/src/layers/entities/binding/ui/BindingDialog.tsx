import { useState, type ReactNode } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  Button,
  CollapsibleFieldCard,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Badge,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  FieldDescription,
} from '@/layers/shared/ui';
import {
  getAgentDisplayName,
  operatorStopForRuntime,
  resolveConfiguredStopMode,
} from '@/layers/shared/lib';
import { useAppForm } from '@/layers/shared/lib/form';
import { useAdapterCatalog, useObservedChats } from '@/layers/entities/relay';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { useConfig } from '@/layers/entities/config';
import { useCapabilitiesForRuntime } from '@/layers/entities/runtime';
import type { PermissionMode } from '@dorkos/shared/schemas';
import { BindingAdvancedSection, BINDING_RUNTIME } from './BindingAdvancedSection';
import {
  buildPreviewSentence,
  CHAT_TYPE_OPTIONS,
  chatTypeLabel,
  SELECT_ANY,
} from '../lib/build-preview-sentence';
import {
  type BindingFormValues,
  buildDefaultValues,
  hasNonDefaultAdvanced,
} from '../model/binding-form';

export interface BindingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the user's configuration when the confirm button is clicked. */
  onConfirm: (values: BindingFormValues) => void | Promise<void>;
  mode?: 'create' | 'edit';
  /** Pre-populate fields. In edit mode, adapter and agent are read-only display values. */
  initialValues?: Partial<BindingFormValues>;
  /** In edit mode, human-readable name of the source adapter (read-only). */
  adapterName?: string;
  /** In edit mode, human-readable name of the target agent (read-only). */
  agentName?: string;
  /**
   * In edit mode, called with the binding ID when the user confirms deletion.
   * When provided, a destructive "Delete" button is shown in the dialog footer.
   */
  onDelete?: (bindingId: string) => void;
  /** The binding ID — required when onDelete is provided. */
  bindingId?: string;
  /** Whether a parent mutation is pending (disables submit button). */
  isPending?: boolean;
  /**
   * Whether this binding is bridged to a channel. Hides the session-strategy
   * selector (a bridged chat keeps its history in the channel — §7.2).
   */
  bridged?: boolean;
  /**
   * The "Bridge to a channel" controls for this binding, rendered in edit mode
   * (chats-as-channels spec §3.1). Supplied by the feature layer so the entity
   * dialog stays free of the cross-entity room reads the bridge action needs.
   */
  bridgeSlot?: ReactNode;
}

/**
 * Modal dialog for configuring or editing an adapter-agent binding.
 *
 * In create mode, shows adapter picker, agent picker, label, and collapsible
 * sections for chat filter and advanced options (session strategy, permissions).
 * In edit mode, adapter and agent are read-only and all other fields are editable.
 */
export function BindingDialog({
  open,
  onOpenChange,
  onConfirm,
  mode,
  initialValues,
  adapterName,
  agentName,
  onDelete,
  bindingId,
  isPending,
  bridged,
  bridgeSlot,
}: BindingDialogProps) {
  const isEdit = mode === 'edit';

  // UI chrome — collapsible section state and security warning, separate from form data.
  const [chatFilterOpen, setChatFilterOpen] = useState(
    () => !!(initialValues?.chatId || initialValues?.channelType)
  );
  const [advancedOpen, setAdvancedOpen] = useState(() => hasNonDefaultAdvanced(initialValues));

  // A NEW binding opens from the operator's own power level (spec
  // `full-power-defaults`, D6): its dial starts at the operator's configured
  // stop mapped to the binding runtime, and "agent can initiate" is pre-selected
  // when the operator chose full power. Both are FORM pre-selections only — the
  // wire defaults (`'default'` mode, `canInitiate: false`) are untouched, so an
  // edited binding keeps its own stored values and nothing changes on the API.
  const { data: config } = useConfig();
  const bindingCaps = useCapabilitiesForRuntime(BINDING_RUNTIME);

  // Snapshot the initial defaults once — used for value-based dirty tracking in edit mode.
  // TanStack Form's built-in isDirty is a one-way ratchet (never resets on revert),
  // so we compare current values against this snapshot ourselves. These consumers
  // mount the dialog only on open, by which point config has loaded.
  const [defaultValues] = useState(() =>
    buildDefaultValues(
      initialValues,
      isEdit
        ? undefined
        : {
            defaultPermissionMode: resolveConfiguredStopMode(
              operatorStopForRuntime(config?.executionDefaults, BINDING_RUNTIME),
              bindingCaps?.permissionModes.values ?? []
            ),
            defaultCanInitiate: config?.ui?.fullPowerChoice === 'full',
          }
    )
  );

  const form = useAppForm({
    defaultValues,
    onSubmit: async ({ value }) => {
      await onConfirm({
        adapterId: value.adapterId,
        agentId: value.agentId,
        sessionStrategy: value.strategy,
        label: value.label,
        permissionMode: value.permissionMode,
        // Convert sentinel back to undefined before submitting.
        chatId: value.chatId === SELECT_ANY ? undefined : value.chatId,
        channelType:
          value.channelType === SELECT_ANY
            ? undefined
            : (value.channelType as BindingFormValues['channelType']),
        canInitiate: value.canInitiate,
        canReply: value.canReply,
        canReceive: value.canReceive,
        notifyOnTaskComplete: value.notifyOnTaskComplete,
      });
      if (!isEdit) {
        form.reset();
      }
    },
  });

  const { data: catalog = [] } = useAdapterCatalog();
  const { data: agentsData } = useRegisteredAgents();

  // Mirror adapterId in local state so useObservedChats stays reactive when
  // the user changes the adapter select — form.state is a synchronous snapshot
  // but doesn't trigger re-renders on its own.
  const [selectedAdapterId, setSelectedAdapterId] = useState(() => initialValues?.adapterId ?? '');
  const { data: observedChats = [] } = useObservedChats(selectedAdapterId || undefined);

  // Flatten enabled adapter instances from the catalog for the picker.
  const adapterOptions = catalog.flatMap((entry) =>
    entry.instances
      .filter((inst) => inst.enabled)
      .map((inst) => ({
        id: inst.id,
        label: inst.label
          ? `${inst.label} (${entry.manifest.displayName})`
          : `${inst.id} (${entry.manifest.displayName})`,
      }))
  );

  const agentOptions = agentsData?.agents ?? [];

  function handleClearFilters() {
    form.setFieldValue('chatId', SELECT_ANY);
    form.setFieldValue('channelType', SELECT_ANY);
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="max-h-[85vh] max-w-md gap-0 p-0">
        <ResponsiveDialogHeader className="border-b px-4 py-3">
          <ResponsiveDialogTitle>
            {isEdit ? 'Edit connection' : 'Add connection'}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="sr-only">
            {isEdit ? "Edit this connection's settings" : 'Add a new connection for this agent'}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <form.Subscribe selector={(s) => ({ values: s.values, isSubmitting: s.isSubmitting })}>
          {({ values, isSubmitting }) => {
            // In create mode, both adapter and agent are required for a valid submission.
            const isValid = isEdit || (!!values.adapterId && !!values.agentId);
            // Dirty tracking via value comparison against the captured defaultValues snapshot.
            // TanStack Form's built-in isDirty is a one-way ratchet and never resets on revert,
            // so we compare each field value directly instead.
            const isDirty =
              !isEdit ||
              values.adapterId !== defaultValues.adapterId ||
              values.agentId !== defaultValues.agentId ||
              values.strategy !== defaultValues.strategy ||
              values.label !== defaultValues.label ||
              values.chatId !== defaultValues.chatId ||
              values.channelType !== defaultValues.channelType ||
              values.permissionMode !== defaultValues.permissionMode ||
              values.canInitiate !== defaultValues.canInitiate ||
              values.canReply !== defaultValues.canReply ||
              values.canReceive !== defaultValues.canReceive ||
              values.notifyOnTaskComplete !== defaultValues.notifyOnTaskComplete;
            // Resolve agent display name for the preview sentence.
            const resolvedAgentName = isEdit
              ? agentName
              : agentOptions.find((a) => a.id === values.agentId)?.name;
            const previewSentence =
              isValid && resolvedAgentName
                ? (() => {
                    const sentence = buildPreviewSentence({
                      sessionStrategy: values.strategy,
                      chatDisplayName:
                        values.chatId !== SELECT_ANY ? `#${values.chatId}` : undefined,
                      channelType:
                        values.channelType !== SELECT_ANY ? values.channelType : undefined,
                    });
                    return `${sentence} — routed to ${resolvedAgentName}.`;
                  })()
                : null;
            // SELECT_ANY means "no filter selected" — used for badge and clear button visibility.
            const hasChatFilter = values.chatId !== SELECT_ANY || values.channelType !== SELECT_ANY;
            // Advanced section badge: non-default when strategy or permissions deviate from defaults.
            const hasAdvancedChanges =
              values.strategy !== 'per-chat' ||
              values.permissionMode !== 'acceptEdits' ||
              values.canInitiate ||
              !values.canReply ||
              !values.canReceive ||
              !values.notifyOnTaskComplete;
            const isSubmitDisabled = !isValid || !isDirty || !!isPending || isSubmitting;
            const isLoading = !!isPending || isSubmitting;

            return (
              <>
                <div className="space-y-5 overflow-y-auto px-4 py-5">
                  {isEdit ? (
                    /* Edit mode: adapter and agent are read-only */
                    <>
                      <p className="text-muted-foreground text-sm">
                        Connection:{' '}
                        <span className="text-foreground font-medium">{adapterName}</span> &rarr;{' '}
                        <span className="text-foreground font-medium">{agentName}</span>
                      </p>
                      {/* Bridge to a channel — supplied by the feature layer (§3.1) */}
                      {bridgeSlot}
                    </>
                  ) : (
                    /* Create mode: adapter and agent pickers */
                    <>
                      <div className="space-y-1.5">
                        <Label htmlFor="binding-adapter">Connection</Label>
                        {adapterOptions.length === 0 ? (
                          <p className="text-muted-foreground border-input rounded-md border px-3 py-2 text-sm opacity-50">
                            No connections set up yet
                          </p>
                        ) : (
                          <form.AppField name="adapterId">
                            {(field) => (
                              <Select
                                value={field.state.value}
                                onValueChange={(v) => {
                                  field.handleChange(v);
                                  setSelectedAdapterId(v);
                                }}
                              >
                                <SelectTrigger id="binding-adapter" className="w-full">
                                  <SelectValue placeholder="Pick a connection" />
                                </SelectTrigger>
                                <SelectContent>
                                  {adapterOptions.map((opt) => (
                                    <SelectItem key={opt.id} value={opt.id}>
                                      {opt.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                          </form.AppField>
                        )}
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor="binding-agent">Agent</Label>
                        {agentOptions.length === 0 ? (
                          <p className="text-muted-foreground border-input rounded-md border px-3 py-2 text-sm opacity-50">
                            No agents registered
                          </p>
                        ) : (
                          <form.AppField name="agentId">
                            {(field) => (
                              <Select value={field.state.value} onValueChange={field.handleChange}>
                                <SelectTrigger id="binding-agent" className="w-full">
                                  <SelectValue placeholder="Select an agent" />
                                </SelectTrigger>
                                <SelectContent>
                                  {agentOptions.map((agent) => (
                                    <SelectItem key={agent.id} value={agent.id}>
                                      {getAgentDisplayName(agent)}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                          </form.AppField>
                        )}
                      </div>
                    </>
                  )}

                  {/* Optional label */}
                  <form.AppField name="label">
                    {(field) => (
                      <div className="space-y-1.5">
                        <Label htmlFor="binding-label">Label (optional)</Label>
                        <Input
                          id="binding-label"
                          placeholder="e.g., Customer support bot"
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(e) => field.handleChange(e.target.value)}
                        />
                        <FieldDescription>A display name for this binding</FieldDescription>
                      </div>
                    )}
                  </form.AppField>

                  {/* Chat filter — collapsible */}
                  <CollapsibleFieldCard
                    open={chatFilterOpen}
                    onOpenChange={setChatFilterOpen}
                    trigger="Chat Filter"
                    badge={
                      hasChatFilter ? (
                        <Badge variant="secondary" className="text-xs">
                          Active
                        </Badge>
                      ) : undefined
                    }
                  >
                    {/* ChatId picker */}
                    <form.AppField name="chatId">
                      {(field) => (
                        <div className="space-y-1.5 px-4 py-3">
                          <Label htmlFor="binding-chat-id">Chat ID</Label>
                          <Select value={field.state.value} onValueChange={field.handleChange}>
                            <SelectTrigger id="binding-chat-id" className="w-full">
                              <SelectValue placeholder="Any chat (wildcard)" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={SELECT_ANY}>Any chat (wildcard)</SelectItem>
                              {observedChats.map((chat) => (
                                <SelectItem key={chat.chatId} value={chat.chatId}>
                                  <span>{chat.displayName ?? chat.chatId}</span>
                                  {(chat.channelType || chat.messageCount > 0) && (
                                    <span className="text-muted-foreground ml-2 text-xs">
                                      {[
                                        chat.channelType ? chatTypeLabel(chat.channelType) : null,
                                        `${chat.messageCount} msgs`,
                                      ]
                                        .filter(Boolean)
                                        .join(' · ')}
                                    </span>
                                  )}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FieldDescription>
                            Route only messages from a specific chat
                          </FieldDescription>
                        </div>
                      )}
                    </form.AppField>

                    {/* ChannelType picker */}
                    <form.AppField name="channelType">
                      {(field) => (
                        <div className="space-y-1.5 px-4 py-3">
                          <Label htmlFor="binding-channel-type">Chat type</Label>
                          <Select value={field.state.value} onValueChange={field.handleChange}>
                            <SelectTrigger id="binding-channel-type" className="w-full">
                              <SelectValue placeholder="Any type (wildcard)" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={SELECT_ANY}>Any type (wildcard)</SelectItem>
                              {CHAT_TYPE_OPTIONS.map((opt) => (
                                <SelectItem key={opt.value} value={opt.value}>
                                  {opt.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                    </form.AppField>

                    {hasChatFilter && (
                      <div className="px-4 py-3">
                        <Button variant="ghost" size="sm" onClick={handleClearFilters}>
                          Clear filters
                        </Button>
                      </div>
                    )}
                  </CollapsibleFieldCard>

                  {/* Advanced — collapsible: session strategy + permission toggles */}
                  <BindingAdvancedSection
                    strategy={values.strategy}
                    onStrategyChange={(v) => form.setFieldValue('strategy', v)}
                    permissionMode={values.permissionMode}
                    onPermissionModeChange={(v) =>
                      form.setFieldValue('permissionMode', v as PermissionMode)
                    }
                    canInitiate={values.canInitiate}
                    onCanInitiateChange={(v) => form.setFieldValue('canInitiate', v)}
                    canReply={values.canReply}
                    onCanReplyChange={(v) => form.setFieldValue('canReply', v)}
                    canReceive={values.canReceive}
                    onCanReceiveChange={(v) => form.setFieldValue('canReceive', v)}
                    notifyOnTaskComplete={values.notifyOnTaskComplete}
                    onNotifyOnTaskCompleteChange={(v) =>
                      form.setFieldValue('notifyOnTaskComplete', v)
                    }
                    notifyBootstrapHint={observedChats.length === 0}
                    bridged={bridged}
                    open={advancedOpen}
                    onOpenChange={setAdvancedOpen}
                    hasChanges={hasAdvancedChanges}
                  />

                  {/* Preview sentence — shown when the form produces a valid binding */}
                  {previewSentence && (
                    <p className="text-muted-foreground bg-muted/50 rounded-md px-3 py-2 text-xs italic">
                      {previewSentence}
                    </p>
                  )}
                </div>

                <ResponsiveDialogFooter className="border-t px-4 py-3">
                  {isEdit && onDelete && bindingId && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="mr-auto text-red-600 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950"
                        >
                          <Trash2 className="mr-1.5 size-3.5" />
                          Remove
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Remove connection</AlertDialogTitle>
                          <AlertDialogDescription>
                            Remove this connection? The agent will no longer receive messages from
                            it.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => onDelete(bindingId)}
                            className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
                          >
                            Remove
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={() => form.handleSubmit()} disabled={isSubmitDisabled}>
                    {isLoading && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                    {isLoading ? 'Saving...' : isEdit ? 'Save Changes' : 'Add connection'}
                  </Button>
                </ResponsiveDialogFooter>
              </>
            );
          }}
        </form.Subscribe>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
