import type { ConnectionState } from '@dorkos/shared/types';
import type { ToolCallState } from '../../model/chat-types';
import type { InteractiveToolHandle } from '../message';
import type { PendingFile } from '../../model/use-file-upload';

/** File upload state passed from the parent. */
export interface FileUploadProps {
  pendingFiles: PendingFile[];
  onFilesSelected: (files: File[]) => void;
  onFileRemove: (id: string) => void;
  /** Put a failed attachment back in line for the next send. */
  onFileRetry: (id: string) => void;
  isUploading: boolean;
  /**
   * True while any attachment failed to upload. Blocks the send: the message
   * would otherwise go to the model with no attachment while the person waited
   * for an answer about a file the agent never received (DOR-480).
   */
  hasFailedUpload: boolean;
}

/** Interactive tool state shared between the message list and input zone. */
export interface InteractionProps {
  active: ToolCallState | null;
  pendingApprovals: ToolCallState[];
  focusedOptionIndex: number;
  onToolRef: (handle: InteractiveToolHandle | null) => void;
  onToolDecided: (toolCallId: string, answers?: Record<string, string>) => void;
}

/** Live-sync connection state for the status-bar connection indicator. */
export interface SyncPresenceProps {
  connectionState: ConnectionState;
}
