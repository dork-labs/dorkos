/**
 * Shared form model for the binding (channel) dialog.
 *
 * Holds the values type submitted by BindingDialog plus the pure mappers that
 * translate those values into the server's create/update request shapes. Kept
 * separate from the dialog component so every surface that opens the dialog
 * (topology graph, connections list, agent channels) maps values identically.
 *
 * @module entities/binding/model/binding-form
 */
import type {
  CreateBindingRequest,
  SessionStrategy,
  UpdateBindingRequest,
} from '@dorkos/shared/relay-schemas';
import type { PermissionMode } from '@dorkos/shared/schemas';
import { SELECT_ANY } from '../lib/build-preview-sentence';

/** Values submitted when the user confirms the binding dialog. */
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

/**
 * Map submitted form values to a binding create request, forwarding every
 * field the user configured (permission mode, chat filter, direction toggles).
 *
 * @param values - The confirmed form values.
 */
export function toCreateBindingRequest(values: BindingFormValues): CreateBindingRequest {
  return {
    adapterId: values.adapterId,
    agentId: values.agentId,
    sessionStrategy: values.sessionStrategy,
    label: values.label,
    permissionMode: values.permissionMode,
    chatId: values.chatId,
    channelType: values.channelType,
    canInitiate: values.canInitiate,
    canReply: values.canReply,
    canReceive: values.canReceive,
  };
}

/**
 * Map submitted form values to a binding update (PATCH) payload containing
 * only the server-updatable fields — `adapterId`/`agentId` are never sent.
 * Cleared chat filters are sent as `null` (JSON drops `undefined`, so `null`
 * is required for the server to actually clear them).
 *
 * @param values - The confirmed form values.
 */
export function toUpdateBindingRequest(values: BindingFormValues): UpdateBindingRequest {
  return {
    sessionStrategy: values.sessionStrategy,
    label: values.label,
    permissionMode: values.permissionMode,
    chatId: values.chatId ?? null,
    channelType: values.channelType ?? null,
    canInitiate: values.canInitiate,
    canReply: values.canReply,
    canReceive: values.canReceive,
  };
}

/**
 * Whether any advanced field deviates from its default — used to auto-open the
 * dialog's collapsible "Advanced" section from initial values.
 *
 * @param vals - Optional partial initial values.
 */
export function hasNonDefaultAdvanced(vals?: Partial<BindingFormValues>): boolean {
  return !!(
    vals?.canInitiate ||
    vals?.canReply === false ||
    vals?.canReceive === false ||
    (vals?.permissionMode !== undefined && vals.permissionMode !== 'acceptEdits') ||
    (vals?.sessionStrategy && vals.sessionStrategy !== 'per-chat')
  );
}

/**
 * Build TanStack Form default values from optional initial values. Unset chat
 * filters collapse to the `SELECT_ANY` sentinel that the dialog uses for
 * "no filter selected".
 *
 * @param vals - Optional partial initial values.
 */
export function buildDefaultValues(vals?: Partial<BindingFormValues>) {
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
