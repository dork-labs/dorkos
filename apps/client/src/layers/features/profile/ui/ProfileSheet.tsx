/**
 * The profile's sheet chrome — the right-side panel it lives in everywhere
 * except inside the session it is about (spec `profile-unification` §1.6).
 *
 * Presentational: it is handed an identity and a stack and draws the sheet
 * around {@link ProfileView}. `ProfileSheetContainer` is what resolves the URL
 * and the roster; the playground renders this one directly.
 *
 * @module features/profile/ui/ProfileSheet
 */
import type { CSSProperties } from 'react';
import {
  ResponsiveSheet,
  ResponsiveSheetContent,
  ResponsiveSheetDescription,
  ResponsiveSheetTitle,
} from '@/layers/shared/ui';
import { teamMemberFace } from '@/layers/entities/team';
import { ProfileView, type ProfileViewProps } from './ProfileView';

export interface ProfileSheetProps extends Omit<ProfileViewProps, 'home'> {
  /** Whether the sheet is on screen. */
  open: boolean;
  /** Called when the sheet wants to close — Escape, the overlay, the X. */
  onOpenChange: (open: boolean) => void;
}

/**
 * A right-side sheet on a pointer, a full-screen one on a phone — both from
 * `ResponsiveSheet`, so this component says nothing about viewports.
 */
export function ProfileSheet({ open, onOpenChange, ...view }: ProfileSheetProps) {
  const face = teamMemberFace(view.member);

  return (
    <ResponsiveSheet open={open} onOpenChange={onOpenChange}>
      <ResponsiveSheetContent
        data-slot="profile-sheet"
        style={{ '--identity-color': face.color } as CSSProperties}
        // 300ms in, not the Sheet primitive's 500. At 500 this was the slowest
        // transition in the identity flow and the most noticeable — you watch a
        // panel arrive rather than find it already there, every time you open
        // one (identity-micro-interactions §3D1).
        //
        // Scoped HERE rather than in `Sheet` or `ResponsiveSheet`, deliberately:
        // the primitive is shared with Settings' panels, and re-timing every
        // sheet in the app is a decision about every sheet in the app. A
        // caller's `className` is merged last, so this outranks the primitive's
        // own duration for this one panel.
        className="flex flex-col gap-0 overflow-hidden p-0 data-[state=open]:duration-300"
      >
        {/* Radix wants a title on every dialog. The portrait's own name is the
            visible one; this says what the panel IS, which is the thing a
            screen reader has not been told yet. */}
        <ResponsiveSheetTitle className="sr-only">Profile</ResponsiveSheetTitle>
        <ResponsiveSheetDescription className="sr-only">
          Profile details for {view.member.displayName}
        </ResponsiveSheetDescription>
        <ProfileView {...view} home="sheet" />
      </ResponsiveSheetContent>
    </ResponsiveSheet>
  );
}
