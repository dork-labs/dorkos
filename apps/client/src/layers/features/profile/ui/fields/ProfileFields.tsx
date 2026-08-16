/**
 * The four fields that edit the person at the keyboard — one card each.
 *
 * **One implementation, two doors** (spec `profile-unification` D8). Settings ›
 * Profile stacks all four; the profile's Name, Handle and Photo pages show one
 * each. They were the same markup twice for about an hour, which is how a fix
 * to one ends up not being a fix to the other.
 *
 * @module features/profile/ui/fields/ProfileFields
 */
import { useRef, useState, type ReactNode } from 'react';
import { OPERATOR_FALLBACK_DISPLAY_NAME, type TeamMember } from '@dorkos/shared/team-schemas';
import {
  Button,
  FieldCard,
  FieldCardContent,
  IdentityAvatar,
  Input,
  SettingRow,
} from '@/layers/shared/ui';
import { teamMemberFace } from '@/layers/entities/team';
import {
  avatarErrorMessage,
  handleErrorMessage,
  nameErrorMessage,
} from '../../model/profile-errors';
import {
  useDeleteProfileAvatar,
  useSetAuthorHandle,
  useUpdateProfileName,
  useUploadProfileAvatar,
} from '../../model/use-profile-edits';

/** What the photo picker will offer. The server decides for real, by the bytes. */
const ACCEPTED_IMAGE_TYPES = 'image/png,image/jpeg,image/webp';

/**
 * A text field the person edits, seeded from a value the server owns.
 *
 * The roster changes under this panel — a successful save refetches it, and so
 * does anything else that renames this person — so a draft has to give way once
 * the stored value itself moves, or the form shows a stale edit of a value that
 * has already changed. Per field rather than per panel: saving your name must
 * not throw away a handle you were half-way through typing.
 *
 * Adjusted during render rather than in an effect, which is React's own
 * prescription for this ("adjusting state when a prop changes") and avoids the
 * extra render pass an effect would add on every roster refetch.
 */
function useServerSeededDraft(serverValue: string): [string, (next: string) => void] {
  const [draft, setDraft] = useState(serverValue);
  const [seed, setSeed] = useState(serverValue);
  if (seed !== serverValue) {
    setSeed(serverValue);
    setDraft(serverValue);
  }
  return [draft, setDraft];
}

/**
 * One line under a field, saying what just happened to it.
 *
 * A refusal is an `alert` because it interrupts what the person was doing; a
 * confirmation is a `status`, which a screen reader announces without stealing
 * focus. Both are per field, because the fields save separately.
 *
 * **A "Saved" note is drawn only while the field still matches what was saved**
 * — the call sites compare the draft against the mutation's own `variables`.
 * TanStack keeps `isSuccess` true indefinitely, so an unconditional note would
 * sit under a field the person had since edited, claiming their unsaved draft
 * was stored. Typing clears it; that is the whole lifecycle, and it needs no
 * timer.
 *
 * Compared against what was SENT rather than against what the roster now says,
 * deliberately: the roster refetch that follows a save is a second round trip,
 * and gating the confirmation on it would make "Saved" appear late, flicker on
 * a slow read, and never appear at all where the refetch cannot happen.
 */
function FieldNote({ tone, children }: { tone: 'error' | 'ok'; children: ReactNode }) {
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      className={tone === 'error' ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}
    >
      {children}
    </p>
  );
}

/** What every field card is handed: the operator's own roster row. */
export interface ProfileFieldProps {
  /** The operator's own roster row. */
  member: TeamMember;
}

/** Your photo: the disc, a file picker, and a way to take it back off. */
export function ProfilePhotoField({ member }: ProfileFieldProps) {
  const face = teamMemberFace(member);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadAvatar = useUploadProfileAvatar();
  const deleteAvatar = useDeleteProfileAvatar();

  function pickPhoto(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    uploadAvatar.mutate({ file });
    // Clear the input so choosing the SAME file again still fires a change.
    if (fileInput.current) fileInput.current.value = '';
  }

  return (
    <FieldCard>
      <FieldCardContent className="space-y-3">
        <SettingRow
          label="Photo"
          description="A PNG, JPEG or WebP, up to 2 MB."
          orientation="vertical"
        >
          <div className="flex items-center gap-3">
            <IdentityAvatar
              size="lg"
              kind={face.kind}
              color={face.color}
              emoji={face.emoji}
              imageUrl={face.imageUrl}
              fallback={face.fallback}
              origin={face.origin}
            />
            <div className="flex flex-wrap gap-2">
              <input
                ref={fileInput}
                type="file"
                accept={ACCEPTED_IMAGE_TYPES}
                className="hidden"
                data-testid="profile-photo-input"
                onChange={(e) => pickPhoto(e.target.files)}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={uploadAvatar.isPending}
                onClick={() => fileInput.current?.click()}
              >
                {member.imageUrl ? 'Change photo' : 'Upload a photo'}
              </Button>
              {member.imageUrl && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={deleteAvatar.isPending}
                  onClick={() => deleteAvatar.mutate()}
                >
                  Remove
                </Button>
              )}
            </div>
          </div>
        </SettingRow>
        {uploadAvatar.isError && (
          <FieldNote tone="error">{avatarErrorMessage(uploadAvatar.error)}</FieldNote>
        )}
        {deleteAvatar.isError && (
          <FieldNote tone="error">{avatarErrorMessage(deleteAvatar.error)}</FieldNote>
        )}
      </FieldCardContent>
    </FieldCard>
  );
}

/** Your display name: what DorkOS calls you. */
export function ProfileNameField({ member }: ProfileFieldProps) {
  const updateName = useUpdateProfileName();

  // `You` is what the roster falls back to when this install knows no other
  // name — nobody chose it. Seeding the field with it would present a
  // placeholder as a decision and then let the person "save" it as their real
  // name; it belongs in the placeholder, where it reads as the guess it is.
  const storedName =
    member.displayName === OPERATOR_FALLBACK_DISPLAY_NAME ? '' : member.displayName;
  const [name, setName] = useServerSeededDraft(storedName);
  const nameChanged = name.trim().length > 0 && name.trim() !== storedName;

  return (
    <FieldCard>
      <FieldCardContent className="space-y-3">
        <SettingRow
          label="Display name"
          description="What DorkOS calls you."
          orientation="vertical"
        >
          <div className="flex gap-2">
            <Input
              value={name}
              maxLength={80}
              aria-label="Display name"
              placeholder={OPERATOR_FALLBACK_DISPLAY_NAME}
              onChange={(e) => setName(e.target.value)}
            />
            <Button
              size="sm"
              disabled={!nameChanged || updateName.isPending}
              onClick={() => updateName.mutate(name.trim())}
            >
              Save
            </Button>
          </div>
        </SettingRow>
        {updateName.isError && (
          <FieldNote tone="error">{nameErrorMessage(updateName.error)}</FieldNote>
        )}
        {updateName.isSuccess && name.trim() === updateName.variables && (
          <FieldNote tone="ok">Saved.</FieldNote>
        )}
      </FieldCardContent>
    </FieldCard>
  );
}

/** Your `@handle`: what people and agents type to reach you. */
export function ProfileHandleField({ member }: ProfileFieldProps) {
  const setHandle = useSetAuthorHandle();
  const [handle, setHandleText] = useServerSeededDraft(member.handle ?? '');
  const handleChanged = handle.trim() !== (member.handle ?? '');

  return (
    <FieldCard>
      <FieldCardContent className="space-y-3">
        <SettingRow
          label="Handle"
          description="What people and agents type after an @ to reach you."
          orientation="vertical"
        >
          <div className="flex gap-2">
            <Input
              value={handle}
              maxLength={64}
              placeholder="yourname"
              aria-label="Handle"
              onChange={(e) => setHandleText(e.target.value)}
            />
            <Button
              size="sm"
              disabled={!handleChanged || setHandle.isPending}
              onClick={() => setHandle.mutate({ authorId: member.id, handle: handle.trim() })}
            >
              Save
            </Button>
          </div>
        </SettingRow>
        {setHandle.isError && (
          <FieldNote tone="error">{handleErrorMessage(setHandle.error, handle.trim())}</FieldNote>
        )}
        {setHandle.isSuccess && handle.trim() === setHandle.variables?.handle && (
          <FieldNote tone="ok">Saved.</FieldNote>
        )}
      </FieldCardContent>
    </FieldCard>
  );
}

/** Your email: read-only here, because it comes from the login. */
export function ProfileEmailField({ member }: ProfileFieldProps) {
  return (
    <FieldCard>
      <FieldCardContent>
        <SettingRow
          label="Email"
          description={
            member.person?.email
              ? 'From the account you signed in with. Change it in Settings › Security.'
              : 'You have no login on this machine. Turn one on in Settings › Security if you want one.'
          }
          orientation="vertical"
        >
          <Input
            readOnly
            aria-label="Email"
            value={member.person?.email ?? ''}
            placeholder="No email on this machine"
            className="text-muted-foreground"
          />
        </SettingRow>
      </FieldCardContent>
    </FieldCard>
  );
}
