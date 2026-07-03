/**
 * DorkOS account feature — the dorkos.ai user-facing auth surface
 * (accounts-and-auth P2): sign-in, sign-up, email verification, password reset,
 * and the signed-in profile. Every component talks to Better Auth only through
 * the `@/lib/auth-client` wrapper.
 *
 * @module features/account
 */
export { AccountProfile, type AccountUser } from './ui/AccountProfile';
export { RequestPasswordResetForm } from './ui/RequestPasswordResetForm';
export { ResetPasswordForm } from './ui/ResetPasswordForm';
export { SignInForm } from './ui/SignInForm';
export { SignUpForm } from './ui/SignUpForm';
export { VerifyEmailCard } from './ui/VerifyEmailCard';
