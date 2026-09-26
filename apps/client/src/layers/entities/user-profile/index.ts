/**
 * User-profile entity — what the person at the keyboard has told DorkOS about
 * themselves: the `profile` block of `~/.dork/config.json` (spec
 * `user-profile-onboarding`), and the one role picker every surface that asks
 * about it draws.
 *
 * An entity rather than part of onboarding because two features read and write
 * it: onboarding asks the questions, and `features/profile`'s Settings ›
 * Profile tab edits the answers. Owning it in either feature made the other
 * import that feature's barrel, and each importing the other closed a cycle.
 *
 * @module entities/user-profile
 */
export { useProfile } from './model/use-profile';
export type { ProfileApi } from './model/use-profile';
export { ProfileRolePicker } from './ui/ProfileRolePicker';
export type { ProfileRolePickerProps } from './ui/ProfileRolePicker';
