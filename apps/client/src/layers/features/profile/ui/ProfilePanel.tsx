/**
 * Settings › Profile — the one place you edit yourself (spec
 * `identity-consistency` §W3.3).
 *
 * Before this, the whole account UI was one email row buried in Settings ›
 * Security. Photo, name and `@handle` now live together at the top of Settings,
 * and the profile drawer's **Edit profile** button lands here.
 *
 * **The identity edited here is the LOCAL one** (§W3.6). The "DorkOS account"
 * tab is a separate device link for analytics and update notices; this panel
 * neither reads it, writes it, nor implies the two are the same account.
 *
 * @module features/profile/ui/ProfilePanel
 */
import { useRef, useState } from 'react';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import {
  Button,
  FieldCard,
  FieldCardContent,
  IdentityAvatar,
  Input,
  SettingRow,
} from '@/layers/shared/ui';
import { resolveIdentityFace } from '@/layers/shared/lib';
import { avatarErrorMessage, handleErrorMessage, nameErrorMessage } from '../model/profile-errors';
import {
  useDeleteProfileAvatar,
  useSetAuthorHandle,
  useUpdateProfileName,
  useUploadProfileAvatar,
} from '../model/use-profile-edits';

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

/** One line under a field, saying what just happened to it. */
function FieldNote({ tone, children }: { tone: 'error' | 'ok'; children: React.ReactNode }) {
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      className={tone === 'error' ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}
    >
      {children}
    </p>
  );
}

export interface ProfilePanelProps {
  /** The operator's own roster row. */
  member: TeamMember;
}

/**
 * Edit your photo, your name and your handle.
 *
 * Each field saves on its own and reports on its own, because they fail for
 * unrelated reasons: a handle can be taken while a name is perfectly fine, and
 * one shared "save" button would make the person re-submit the part that worked.
 */
export function ProfilePanel({ member }: ProfilePanelProps) {
  const face = resolveIdentityFace({
    record: {
      id: member.id,
      kind: member.kind,
      displayName: member.displayName,
      ...(member.emoji ? { emoji: member.emoji } : {}),
      ...(member.color ? { color: member.color } : {}),
      ...(member.imageUrl ? { imageUrl: member.imageUrl } : {}),
    },
    origin: member.origin,
  });

  const fileInput = useRef<HTMLInputElement>(null);
  const uploadAvatar = useUploadProfileAvatar();
  const deleteAvatar = useDeleteProfileAvatar();
  const updateName = useUpdateProfileName();
  const setHandle = useSetAuthorHandle();

  const [name, setName] = useServerSeededDraft(member.displayName);
  const [handle, setHandleText] = useServerSeededDraft(member.handle ?? '');

  const nameChanged = name.trim().length > 0 && name.trim() !== member.displayName;
  const handleChanged = handle.trim() !== (member.handle ?? '');

  function pickPhoto(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    uploadAvatar.mutate({ file });
    // Clear the input so choosing the SAME file again still fires a change.
    if (fileInput.current) fileInput.current.value = '';
  }

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        How you appear across DorkOS — on your team page, in every room, and beside everything you
        write.
      </p>

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
        </FieldCardContent>
      </FieldCard>

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
        </FieldCardContent>
      </FieldCard>

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
    </div>
  );
}
