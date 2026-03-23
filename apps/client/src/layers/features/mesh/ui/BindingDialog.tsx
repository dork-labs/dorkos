import { useState } from 'react';
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
import { useAppForm } from '@/layers/shared/lib/form';
import { useAdapterCatalog, useObservedChats } from '@/layers/entities/relay';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import type { SessionStrategy } from '@dorkos/shared/relay-schemas';
import type { PermissionMode } from '@dorkos/shared/schemas';
import { BindingAdvancedSection } from './BindingAdvancedSection';

const CHANNEL_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'dm', label: 'Direct Message' },
  { value: 'group', label: 'Group' },
  { value: 'channel', label: 'Channel' },
  { value: 'thread', label: 'Thread' },
];

/**
 * Sentinel value used for Radix Select "any / no filter" option.
 * Radix forbids empty-string values on SelectItem, so we use this
 * sentinel and convert back to undefined before submitting.
 */
const SELECT_ANY = '__any__';

/** Values submitted when the user confirms the dialog. */
export interface BindingFormValues {
  adapterId: string;
  agentId: string;
  sessionStrategy: SessionStrategy;
  label: string;
  permissionMode?: PermissionMode;
  chatId?: string;
  channelType?: 'dm' | 'group' | 'channel' | 'thread';
  canInitiate?: boolean;
  canReply?: boolean;
  canReceive?: boolean;
}

/** Compute whether advanced section should auto-open from initial values. */
function hasNonDefaultAdvanced(vals?: Partial<BindingFormValues>): boolean {
  return !!(
    vals?.canInitiate ||
    vals?.canReply === false ||
    vals?.canReceive === false ||
    (vals?.permissionMode !== undefined && vals.permissionMode !== 'acceptEdits') ||
    (vals?.sessionStrategy && vals.sessionStrategy !== 'per-chat')
  );
}

/** Human-readable strategy labels for the preview sentence. */
const STRATEGY_LABELS: Record<SessionStrategy, string> = {
  'per-chat': 'per-chat sessions',
  'per-user': 'per-user sessions',
  stateless: 'stateless sessions',
};

/**
 * Build a human-readable preview of what the binding will do.
 *
 * @param values - Current form values
 * @param agentName - Resolved display name of the selected agent
 */
function buildPreviewSentence(
  values: { chatId: string; channelType: string; strategy: SessionStrategy },
  agentName: string | undefined
): string | null {
  if (!agentName) return null;

  const scope =
    values.chatId !== SELECT_ANY
      ? `Messages from #${values.chatId}`
      : values.channelType !== SELECT_ANY
        ? `${values.channelType.charAt(0).toUpperCase() + values.channelType.slice(1)} messages`
        : 'All messages';

  return `${scope} will be routed to ${agentName} using ${STRATEGY_LABELS[values.strategy]}.`;
}

/** Build TanStack Form default values from optional initial values. */
function buildDefaultValues(vals?: Partial<BindingFormValues>) {
  return {
    adapterId: vals?.adapterId ?? '',
    agentId: vals?.agentId ?? '',
    strategy: (vals?.sessionStrategy ?? 'per-chat') as SessionStrategy,
    label: vals?.label ?? '',
    chatId: vals?.chatId ?? SELECT_ANY,
    channelType: vals?.channelType ?? SELECT_ANY,
    permissionMode: (vals?.permissionMode ?? 'acceptEdits') as PermissionMode,
    canInitiate: vals?.canInitiate ?? false,
    canReply: vals?.canReply ?? true,
    canReceive: vals?.canReceive ?? true,
  };
}

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
}: BindingDialogProps) {
  const isEdit = mode === 'edit';

  // UI chrome — collapsible section state and security warning, separate from form data.
  const [chatFilterOpen, setChatFilterOpen] = useState(
    () => !!(initialValues?.chatId || initialValues?.channelType)
  );
  const [advancedOpen, setAdvancedOpen] = useState(() => hasNonDefaultAdvanced(initialValues));
  // Track whether the bypass-permissions security warning is open.
  const [bypassWarningOpen, setBypassWarningOpen] = useState(false);

  // Snapshot the initial defaults once — used for value-based dirty tracking in edit mode.
  // TanStack Form's built-in isDirty is a one-way ratchet (never resets on revert),
  // so we compare current values against this snapshot ourselves.
  const [defaultValues] = useState(() => buildDefaultValues(initialValues));

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

  /** Handle permission mode selection with security warning for bypassPermissions. */
  function handlePermissionModeChange(value: string) {
    if (value === 'bypassPermissions') {
      setBypassWarningOpen(true);
    } else {
      form.setFieldValue('permissionMode', value as PermissionMode);
    }
  }

  function handleClearFilters() {
    form.setFieldValue('chatId', SELECT_ANY);
    form.setFieldValue('channelType', SELECT_ANY);
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="max-h-[85vh] max-w-md gap-0 p-0">
        <ResponsiveDialogHeader className="border-b px-4 py-3">
          <ResponsiveDialogTitle>
            {isEdit ? 'Edit Binding' : 'Create Binding'}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="sr-only">
            {isEdit
              ? 'Modify the binding configuration'
              : 'Configure how the adapter connects to the agent'}
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
              values.canReceive !== defaultValues.canReceive;
            // Resolve agent display name for the preview sentence.
            const resolvedAgentName = isEdit
              ? agentName
              : agentOptions.find((a) => a.id === values.agentId)?.name;
            const previewSentence = isValid
              ? buildPreviewSentence(
                  {
                    chatId: values.chatId,
                    channelType: values.channelType,
                    strategy: values.strategy,
                  },
                  resolvedAgentName
                )
              : null;
            // SELECT_ANY means "no filter selected" — used for badge and clear button visibility.
            const hasChatFilter = values.chatId !== SELECT_ANY || values.channelType !== SELECT_ANY;
            // Advanced section badge: non-default when strategy or permissions deviate from defaults.
            const hasAdvancedChanges =
              values.strategy !== 'per-chat' ||
              values.permissionMode !== 'acceptEdits' ||
              values.canInitiate ||
              !values.canReply ||
              !values.canReceive;
            const isSubmitDisabled = !isValid || !isDirty || !!isPending || isSubmitting;
            const isLoading = !!isPending || isSubmitting;

            return (
              <>
                <div className="space-y-5 overflow-y-auto px-4 py-5">
                  {isEdit ? (
                    /* Edit mode: adapter and agent are read-only */
                    <p className="text-muted-foreground text-sm">
                      Binding: <span className="text-foreground font-medium">{adapterName}</span> to{' '}
                      <span className="text-foreground font-medium">{agentName}</span>
                    </p>
                  ) : (
                    /* Create mode: adapter and agent pickers */
                    <>
                      <div className="space-y-1.5">
                        <Label htmlFor="binding-adapter">Adapter</Label>
                        {adapterOptions.length === 0 ? (
                          <p className="text-muted-foreground border-input rounded-md border px-3 py-2 text-sm opacity-50">
                            No adapters configured
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
                                  <SelectValue placeholder="Select an adapter" />
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
                                      {agent.name}
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
                                      {[chat.channelType, `${chat.messageCount} msgs`]
                                        .filter(Boolean)
                                        .join(' · ')}
                                    </span>
                                  )}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FieldDescription>
                            Route only messages from a specific chat or channel
                          </FieldDescription>
                        </div>
                      )}
                    </form.AppField>

                    {/* ChannelType picker */}
                    <form.AppField name="channelType">
                      {(field) => (
                        <div className="space-y-1.5 px-4 py-3">
                          <Label htmlFor="binding-channel-type">Channel Type</Label>
                          <Select value={field.state.value} onValueChange={field.handleChange}>
                            <SelectTrigger id="binding-channel-type" className="w-full">
                              <SelectValue placeholder="Any type (wildcard)" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={SELECT_ANY}>Any type (wildcard)</SelectItem>
                              {CHANNEL_TYPE_OPTIONS.map((opt) => (
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
                    onPermissionModeChange={handlePermissionModeChange}
                    bypassWarningOpen={bypassWarningOpen}
                    onBypassWarningOpenChange={setBypassWarningOpen}
                    onBypassConfirm={() =>
                      form.setFieldValue('permissionMode', 'bypassPermissions')
                    }
                    canInitiate={values.canInitiate}
                    onCanInitiateChange={(v) => form.setFieldValue('canInitiate', v)}
                    canReply={values.canReply}
                    onCanReplyChange={(v) => form.setFieldValue('canReply', v)}
                    canReceive={values.canReceive}
                    onCanReceiveChange={(v) => form.setFieldValue('canReceive', v)}
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
                          Delete
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete binding</AlertDialogTitle>
                          <AlertDialogDescription>
                            Are you sure you want to delete this binding? The adapter will no longer
                            route messages to the connected agent.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => onDelete(bindingId)}
                            className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
                          >
                            Delete
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
                    {isLoading ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Binding'}
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
