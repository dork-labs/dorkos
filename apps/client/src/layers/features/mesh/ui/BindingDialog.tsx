import { useState, useEffect, useMemo } from 'react';
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

/** Internal form state — includes data fields and UI chrome (collapsible sections). */
interface BindingFormState {
  adapterId: string;
  agentId: string;
  strategy: SessionStrategy;
  label: string;
  chatId: string;
  channelType: string;
  permissionMode: PermissionMode;
  canInitiate: boolean;
  canReply: boolean;
  canReceive: boolean;
  chatFilterOpen: boolean;
  advancedOpen: boolean;
}

/** Data field keys used for dirty checking (excludes UI chrome). */
const DATA_KEYS: (keyof BindingFormState)[] = [
  'adapterId',
  'agentId',
  'strategy',
  'label',
  'chatId',
  'channelType',
  'permissionMode',
  'canInitiate',
  'canReply',
  'canReceive',
];

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

/** Build a human-readable preview of what the binding will do. */
function buildPreviewSentence(
  form: BindingFormState,
  agentName: string | undefined,
  selectAny: string
): string | null {
  if (!agentName) return null;

  const scope =
    form.chatId !== selectAny
      ? `Messages from #${form.chatId}`
      : form.channelType !== selectAny
        ? `${form.channelType.charAt(0).toUpperCase() + form.channelType.slice(1)} messages`
        : 'All messages';

  return `${scope} will be routed to ${agentName} using ${STRATEGY_LABELS[form.strategy]}.`;
}

/** Build form state from optional initial values or defaults. */
function buildInitialState(vals?: Partial<BindingFormValues>): BindingFormState {
  return {
    adapterId: vals?.adapterId ?? '',
    agentId: vals?.agentId ?? '',
    strategy: vals?.sessionStrategy ?? 'per-chat',
    label: vals?.label ?? '',
    chatId: vals?.chatId ?? SELECT_ANY,
    channelType: vals?.channelType ?? SELECT_ANY,
    permissionMode: vals?.permissionMode ?? 'acceptEdits',
    canInitiate: vals?.canInitiate ?? false,
    canReply: vals?.canReply ?? true,
    canReceive: vals?.canReceive ?? true,
    chatFilterOpen: !!(vals?.chatId || vals?.channelType),
    advancedOpen: hasNonDefaultAdvanced(vals),
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

  const [form, setForm] = useState<BindingFormState>(() => buildInitialState(initialValues));
  // Track whether the bypass-permissions security warning is open (UI chrome, not form data).
  const [bypassWarningOpen, setBypassWarningOpen] = useState(false);
  // Local submitting state to track async onConfirm lifecycle.
  const [submitting, setSubmitting] = useState(false);

  /** Update a single form field. */
  function updateField<K extends keyof BindingFormState>(key: K, value: BindingFormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  // Sync form state when initialValues change (e.g. opening a different binding to edit).
  useEffect(() => {
    setForm(buildInitialState(initialValues));
  }, [initialValues]);

  // Memoized initial state snapshot for dirty tracking in edit mode.
  const initialState = useMemo(() => buildInitialState(initialValues), [initialValues]);

  const isDirty = useMemo(() => {
    if (!isEdit) return true;
    return DATA_KEYS.some((k) => form[k] !== initialState[k]);
  }, [form, initialState, isEdit]);

  const { data: catalog = [] } = useAdapterCatalog();
  const { data: agentsData } = useRegisteredAgents();
  const { data: observedChats = [] } = useObservedChats(form.adapterId || undefined);

  // Flatten enabled adapter instances from the catalog for the picker
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

  // In create mode, both adapter and agent are required for a valid submission.
  const isValid = isEdit || (!!form.adapterId && !!form.agentId);

  // Resolve agent display name for the preview sentence.
  const resolvedAgentName = isEdit
    ? agentName
    : agentOptions.find((a) => a.id === form.agentId)?.name;
  const previewSentence = isValid
    ? buildPreviewSentence(form, resolvedAgentName, SELECT_ANY)
    : null;

  // SELECT_ANY means "no filter selected" — convert back to undefined before submitting.
  const hasChatFilter = form.chatId !== SELECT_ANY || form.channelType !== SELECT_ANY;
  // Advanced section has non-default values when strategy or permissions deviate from defaults.
  const hasAdvancedChanges =
    form.strategy !== 'per-chat' ||
    form.permissionMode !== 'acceptEdits' ||
    form.canInitiate ||
    !form.canReply ||
    !form.canReceive;

  async function handleConfirm() {
    if (!isValid || submitting) return;

    setSubmitting(true);
    try {
      await onConfirm({
        adapterId: form.adapterId,
        agentId: form.agentId,
        sessionStrategy: form.strategy,
        label: form.label,
        permissionMode: form.permissionMode,
        chatId: form.chatId === SELECT_ANY ? undefined : form.chatId,
        channelType:
          form.channelType === SELECT_ANY
            ? undefined
            : (form.channelType as BindingFormValues['channelType']),
        canInitiate: form.canInitiate,
        canReply: form.canReply,
        canReceive: form.canReceive,
      });
      if (!isEdit) {
        setForm(buildInitialState());
      }
    } finally {
      setSubmitting(false);
    }
  }

  /** Handle permission mode selection with security warning for bypassPermissions. */
  function handlePermissionModeChange(value: string) {
    if (value === 'bypassPermissions') {
      setBypassWarningOpen(true);
    } else {
      updateField('permissionMode', value as PermissionMode);
    }
  }

  function handleCancel() {
    onOpenChange(false);
  }

  function handleClearFilters() {
    setForm((prev) => ({ ...prev, chatId: SELECT_ANY, channelType: SELECT_ANY }));
  }

  const isSubmitDisabled = !isValid || !isDirty || !!isPending || submitting;
  const isLoading = !!isPending || submitting;

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
                  <Select value={form.adapterId} onValueChange={(v) => updateField('adapterId', v)}>
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
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="binding-agent">Agent</Label>
                {agentOptions.length === 0 ? (
                  <p className="text-muted-foreground border-input rounded-md border px-3 py-2 text-sm opacity-50">
                    No agents registered
                  </p>
                ) : (
                  <Select value={form.agentId} onValueChange={(v) => updateField('agentId', v)}>
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
              </div>
            </>
          )}

          {/* Optional label */}
          <div className="space-y-1.5">
            <Label htmlFor="binding-label">Label (optional)</Label>
            <Input
              id="binding-label"
              placeholder="e.g., Customer support bot"
              value={form.label}
              onChange={(e) => updateField('label', e.target.value)}
            />
            <FieldDescription>A display name for this binding</FieldDescription>
          </div>

          {/* Chat filter — collapsible */}
          <CollapsibleFieldCard
            open={form.chatFilterOpen}
            onOpenChange={(v) => updateField('chatFilterOpen', v)}
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
            <div className="space-y-1.5 px-4 py-3">
              <Label htmlFor="binding-chat-id">Chat ID</Label>
              <Select value={form.chatId} onValueChange={(v) => updateField('chatId', v)}>
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

            {/* ChannelType picker */}
            <div className="space-y-1.5 px-4 py-3">
              <Label htmlFor="binding-channel-type">Channel Type</Label>
              <Select value={form.channelType} onValueChange={(v) => updateField('channelType', v)}>
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
            strategy={form.strategy}
            onStrategyChange={(v) => updateField('strategy', v)}
            permissionMode={form.permissionMode}
            onPermissionModeChange={handlePermissionModeChange}
            bypassWarningOpen={bypassWarningOpen}
            onBypassWarningOpenChange={setBypassWarningOpen}
            onBypassConfirm={() => updateField('permissionMode', 'bypassPermissions')}
            canInitiate={form.canInitiate}
            onCanInitiateChange={(v) => updateField('canInitiate', v)}
            canReply={form.canReply}
            onCanReplyChange={(v) => updateField('canReply', v)}
            canReceive={form.canReceive}
            onCanReceiveChange={(v) => updateField('canReceive', v)}
            open={form.advancedOpen}
            onOpenChange={(v) => updateField('advancedOpen', v)}
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
                    Are you sure you want to delete this binding? The adapter will no longer route
                    messages to the connected agent.
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
          <Button variant="ghost" size="sm" onClick={handleCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleConfirm} disabled={isSubmitDisabled}>
            {isLoading && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
            {isLoading ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Binding'}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
