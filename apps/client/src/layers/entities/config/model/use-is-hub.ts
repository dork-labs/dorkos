/**
 * Whether the app runs on a hub: a person's own DorkOS in the cloud, where the
 * settings that only make sense on a computer (this computer's password,
 * remote access, agent runtimes, keep-awake, linking to a DorkOS account) do
 * not apply.
 *
 * @module entities/config/model/use-is-hub
 */
import { useConfig } from './use-config';

/**
 * `true` only once the server says it is a hub. An older server, or an answer
 * not in yet, is a computer, which is what it was before this existed.
 */
export function useIsHub(): boolean {
  return useConfig().data?.serverRole === 'hub';
}
