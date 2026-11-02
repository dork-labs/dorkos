import { Button, Field, FieldLabel, Input } from '@dork-labs/ui';
import { COMMUNITY_PASSWORD_MIN_LENGTH } from '@dorkos/shared/community-wire';

type Props = {
  mode: 'signup' | 'signin';
  value: string;
  onChange: (value: string) => void;
  /** Whether this space mails reset links, so a forgotten password can be reset here. */
  emailLinks: boolean;
  onForgot: () => void;
};

/** The password field of the sign-in and sign-up form, with its hint or reset link. */
export function PasswordField({ mode, value, onChange, emailLinks, onForgot }: Props) {
  return (
    <Field className="mb-4 gap-1.5">
      <FieldLabel htmlFor="password">Password</FieldLabel>
      <Input
        id="password"
        type="password"
        autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
        // Only a new password must meet today's length; an older, shorter one still signs in.
        minLength={mode === 'signup' ? COMMUNITY_PASSWORD_MIN_LENGTH : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required
      />
      {mode === 'signin' && emailLinks ? (
        <Button
          type="button"
          variant="link"
          className="h-auto justify-start p-0"
          onClick={onForgot}
        >
          Forgot password?
        </Button>
      ) : mode === 'signin' ? (
        <span className="hint">
          Forgot your password? Ask the person running this space for help.
        </span>
      ) : (
        <span className="hint">At least {COMMUNITY_PASSWORD_MIN_LENGTH} characters.</span>
      )}
    </Field>
  );
}
