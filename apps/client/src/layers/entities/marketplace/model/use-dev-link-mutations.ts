import { useMutation } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type {
  DevLinkCreateInput,
  DevLinkPreviewInput,
  DevLinkPreviewResponse,
  DevLinkScopeInput,
  DevUnlinkResult,
} from '@dorkos/shared/marketplace-schemas';
import type { DevLinkCreateResult } from '@dorkos/shared/transport';
import { useInvalidateDevLinkViews } from './use-dev-links';
import { useDevLinkReloadStore } from './dev-link-reload-store';

/**
 * Ask what linking a folder would do, changing nothing. A refusal rejects with
 * the server's `code` and its one plain sentence, which the dialog shows under
 * the path field as is, so no global error toast is raised for it.
 */
export function usePreviewDevLink() {
  const transport = useTransport();
  return useMutation<DevLinkPreviewResponse, Error, DevLinkPreviewInput>({
    mutationFn: (input) => transport.previewDevLink(input),
    meta: { suppressErrorToast: true },
  });
}

/**
 * Run a package from a folder. The caller sends the preview's `change` back as
 * `expectedChange`, so a folder that changed since the person read the dialog
 * is refused with `dev_link_changed` rather than linked. The dialog reports
 * every refusal itself.
 */
export function useLinkFolder() {
  const transport = useTransport();
  const invalidate = useInvalidateDevLinkViews();
  const forget = useDevLinkReloadStore((s) => s.forget);
  return useMutation<DevLinkCreateResult, Error, DevLinkCreateInput>({
    mutationFn: (input) => transport.linkDevLink(input),
    meta: { suppressErrorToast: true },
    onSuccess: (result) => {
      if (result.status !== 'linked') return;
      // A new link starts with no reload behind it. Keyed by what the server
      // answered, so a project link uses the project's real path.
      forget(result.link);
      invalidate();
    },
  });
}

/** Arguments for {@link useUnlinkDevLink}. */
export interface UnlinkDevLinkArgs extends DevLinkScopeInput {
  /** The package name. */
  name: string;
}

/**
 * Stop running a package from a folder: the installed copy comes back, or the
 * package is removed. The person's folder is never touched. The caller says
 * what happened in its own toast.
 */
export function useUnlinkDevLink() {
  const transport = useTransport();
  const invalidate = useInvalidateDevLinkViews();
  const forget = useDevLinkReloadStore((s) => s.forget);
  return useMutation<DevUnlinkResult, Error, UnlinkDevLinkArgs>({
    mutationFn: ({ name, ...scope }) => transport.unlinkDevLink(name, scope),
    meta: { suppressErrorToast: true },
    onSuccess: (_result, link) => {
      forget(link);
      invalidate();
    },
  });
}
