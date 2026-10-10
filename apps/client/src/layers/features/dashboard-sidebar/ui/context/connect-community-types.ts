/**
 * The types the Join dialog is opened and kept with, beside `ConnectCommunityDialog.tsx`.
 *
 * @module features/dashboard-sidebar/ui/context/connect-community-types
 */
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';

/** What the connect dialog was opened for. */
export interface ConnectCommunityRequest {
  /** A connection that is not connected yet (pending or needing reconnection), or `null` for the form. */
  ref: string | null;
  /** The address the form opens with, such as the official DorkOS space's link. */
  url?: string;
}

/** Props for the Join dialog, `ConnectCommunityDialog`. */
export interface ConnectCommunityDialogProps {
  /** What to show, or `null` while the dialog is closed. */
  request: ConnectCommunityRequest | null;
  onOpenChange: (open: boolean) => void;
  /** This installation's name, offered as the name the Community will know it by. */
  installName: string;
  /** Runs once the connection on screen is approved, with its ref, after the dialog closes. */
  onConnected: (ref: string) => void;
}

/** A value that belongs to one confirmed owner, so a switch of owner hides it. */
export interface OwnedValue<T> {
  address: string;
  value: T;
}

/** The connection a start returned, and whether the list has answered since. */
export interface Started {
  address: string;
  connection: CommunityConnectionDescriptor;
  /** The list has been re-read after the start, so it is the truth from here on. */
  settled: boolean;
}
