import { useState, useEffect } from 'react';
import { Trash2 } from 'lucide-react';
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

export interface BindingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the user's configuration when the confirm button is clicked. */
  onConfirm: (values: BindingFormValues) => void;
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
}: BindingDialogProps) {
  const isEdit = mode === 'edit';

  const [adapterId, setAdapterId] = useState(initialValues?.adapterId ?? '');
  const [agentId, setAgentId] = useState(initialValues?.agentId ?? '');
  const [strategy, setStrategy] = useState<SessionStrategy>(
    initialValues?.sessionStrategy ?? 'per-chat'
  );
  const [label, setLabel] = useState(initialValues?.label ?? '');
  // Use SELECT_ANY as the internal "no filter" value; empty string is forbidden by Radix Select.
  const [chatId, setChatId] = useState(initialValues?.chatId ?? SELECT_ANY);
  const [channelType, setChannelType] = useState(initialValues?.channelType ?? SELECT_ANY);
  // Auto-open chat filter section when initial values already have a filter set.
  const [chatFilterOpen, setChatFilterOpen] = useState(
    !!(initialValues?.chatId || initialValues?.channelType)
  );
  // Permission fields — defaults match AdapterBindingSchema defaults.
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    initialValues?.permissionMode ?? 'acceptEdits'
  );
  const [canInitiate, setCanInitiate] = useState(initialValues?.canInitiate ?? false);
  const [canReply, setCanReply] = useState(initialValues?.canReply ?? true);
  const [canReceive, setCanReceive] = useState(initialValues?.canReceive ?? true);
  // Track whether the bypass-permissions security warning is open.
  const [bypassWarningOpen, setBypassWarningOpen] = useState(false);
  // Auto-open advanced section when initial values have non-default permissions or strategy.
  const [advancedOpen, setAdvancedOpen] = useState(
    !!(
      initialValues?.canInitiate ||
      initialValues?.canReply === false ||
      initialValues?.canReceive === false ||
      (initialValues?.permissionMode !== undefined &&
        initialValues.permissionMode !== 'acceptEdits') ||
      (initialValues?.sessionStrategy && initialValues.sessionStrategy !== 'per-chat')
    )
  );

  // Sync all state when initialValues change (e.g. opening a different binding to edit)
  /* eslint-disable react-hooks/set-state-in-effect -- batch-reset form state from new initialValues prop */
  useEffect(() => {
    if (initialValues) {
      setAdapterId(initialValues.adapterId ?? '');
      setAgentId(initialValues.agentId ?? '');
      setStrategy(initialValues.sessionStrategy ?? 'per-chat');
      setLabel(initialValues.label ?? '');
      setChatId(initialValues.chatId ?? SELECT_ANY);
      setChannelType(initialValues.channelType ?? SELECT_ANY);
      setPermissionMode(initialValues.permissionMode ?? 'acceptEdits');
      setCanInitiate(initialValues.canInitiate ?? false);
      setCanReply(initialValues.canReply ?? true);
      setCanReceive(initialValues.canReceive ?? true);
      if (initialValues.chatId || initialValues.channelType) {
        setChatFilterOpen(true);
      }
      if (
        initialValues.canInitiate ||
        initialValues.canReply === false ||
        initialValues.canReceive === false ||
        (initialValues.permissionMode !== undefined &&
          initialValues.permissionMode !== 'acceptEdits') ||
        (initialValues.sessionStrategy && initialValues.sessionStrategy !== 'per-chat')
      ) {
        setAdvancedOpen(true);
      }
    }
  }, [initialValues]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const { data: catalog = [] } = useAdapterCatalog();
  const { data: agentsData } = useRegisteredAgents();
  const { data: observedChats = [] } = useObservedChats(adapterId || undefined);

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

  // SELECT_ANY means "no filter selected" — convert back to undefined before submitting.
  const hasChatFilter = chatId !== SELECT_ANY || channelType !== SELECT_ANY;
  // Advanced section has non-default values when strategy or permissions deviate from defaults.
  const hasAdvancedChanges =
    strategy !== 'per-chat' ||
    permissionMode !== 'acceptEdits' ||
    canInitiate ||
    !canReply ||
    !canReceive;

  function handleConfirm() {
    onConfirm({
      adapterId,
      agentId,
      sessionStrategy: strategy,
      label,
      permissionMode,
      chatId: chatId === SELECT_ANY ? undefined : chatId,
      channelType:
        channelType === SELECT_ANY ? undefined : (channelType as BindingFormValues['channelType']),
      canInitiate,
      canReply,
      canReceive,
    });
    if (!isEdit) {
      resetForm();
    }
  }

  function resetForm() {
    setAdapterId('');
    setAgentId('');
    setStrategy('per-chat');
    setLabel('');
    setPermissionMode('acceptEdits');
    setChatId(SELECT_ANY);
    setChannelType(SELECT_ANY);
    setChatFilterOpen(false);
    setCanInitiate(false);
    setCanReply(true);
    setCanReceive(true);
    setAdvancedOpen(false);
  }

  /** Handle permission mode selection with security warning for bypassPermissions. */
  function handlePermissionModeChange(value: string) {
    if (value === 'bypassPermissions') {
      setBypassWarningOpen(true);
    } else {
      setPermissionMode(value as PermissionMode);
    }
  }

  function handleCancel() {
    onOpenChange(false);
  }

  function handleClearFilters() {
    setChatId(SELECT_ANY);
    setChannelType(SELECT_ANY);
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
                <Select value={adapterId} onValueChange={setAdapterId}>
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
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="binding-agent">Agent</Label>
                <Select value={agentId} onValueChange={(id) => setAgentId(id)}>
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
              </div>
            </>
          )}

          {/* Optional label */}
          <div className="space-y-1.5">
            <Label htmlFor="binding-label">Label (optional)</Label>
            <Input
              id="binding-label"
              placeholder="e.g., Customer support bot"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>

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
            <div className="space-y-1.5 px-4 py-3">
              <Label htmlFor="binding-chat-id">Chat ID</Label>
              <Select value={chatId} onValueChange={setChatId}>
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
            </div>

            {/* ChannelType picker */}
            <div className="space-y-1.5 px-4 py-3">
              <Label htmlFor="binding-channel-type">Channel Type</Label>
              <Select value={channelType} onValueChange={setChannelType}>
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
            strategy={strategy}
            onStrategyChange={setStrategy}
            permissionMode={permissionMode}
            onPermissionModeChange={handlePermissionModeChange}
            bypassWarningOpen={bypassWarningOpen}
            onBypassWarningOpenChange={setBypassWarningOpen}
            onBypassConfirm={() => setPermissionMode('bypassPermissions')}
            canInitiate={canInitiate}
            onCanInitiateChange={setCanInitiate}
            canReply={canReply}
            onCanReplyChange={setCanReply}
            canReceive={canReceive}
            onCanReceiveChange={setCanReceive}
            open={advancedOpen}
            onOpenChange={setAdvancedOpen}
            hasChanges={hasAdvancedChanges}
          />
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
          <Button size="sm" onClick={handleConfirm}>
            {isEdit ? 'Save Changes' : 'Create Binding'}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
