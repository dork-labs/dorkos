/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useAppForm } from '@/layers/shared/lib/form';

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Minimal wrappers that exercise each field component via useAppForm so that
// the field context is always properly set up.
// ---------------------------------------------------------------------------

function TextFieldFixture({ description }: { description?: string }) {
  const form = useAppForm({ defaultValues: { username: '' } });
  return (
    <form.AppForm>
      <form.AppField name="username">
        {(field) => (
          <field.TextField
            label="Username"
            placeholder="Enter username"
            description={description}
          />
        )}
      </form.AppField>
    </form.AppForm>
  );
}

function TextareaFieldFixture({ description }: { description?: string }) {
  const form = useAppForm({ defaultValues: { bio: '' } });
  return (
    <form.AppForm>
      <form.AppField name="bio">
        {(field) => (
          <field.TextareaField
            label="Bio"
            placeholder="Tell us about yourself"
            description={description}
          />
        )}
      </form.AppField>
    </form.AppForm>
  );
}

function SelectFieldFixture({ description }: { description?: string }) {
  const form = useAppForm({ defaultValues: { role: '' } });
  const options = [
    { value: 'admin', label: 'Admin' },
    { value: 'user', label: 'User' },
  ];
  return (
    <form.AppForm>
      <form.AppField name="role">
        {(field) => (
          <field.SelectField
            label="Role"
            options={options}
            placeholder="Select a role"
            description={description}
          />
        )}
      </form.AppField>
    </form.AppForm>
  );
}

function SwitchFieldFixture({ description }: { description?: string }) {
  const form = useAppForm({ defaultValues: { enabled: false } });
  return (
    <form.AppForm>
      <form.AppField name="enabled">
        {(field) => <field.SwitchField label="Enable feature" description={description} />}
      </form.AppField>
    </form.AppForm>
  );
}

function CheckboxFieldFixture({ description }: { description?: string }) {
  const form = useAppForm({ defaultValues: { agreed: false } });
  return (
    <form.AppForm>
      <form.AppField name="agreed">
        {(field) => <field.CheckboxField label="I agree to the terms" description={description} />}
      </form.AppField>
    </form.AppForm>
  );
}

function PasswordFieldFixture({ description }: { description?: string }) {
  const form = useAppForm({ defaultValues: { password: '' } });
  return (
    <form.AppForm>
      <form.AppField name="password">
        {(field) => (
          <field.PasswordField
            label="Password"
            placeholder="Enter password"
            description={description}
          />
        )}
      </form.AppField>
    </form.AppForm>
  );
}

function SubmitButtonFixture() {
  const form = useAppForm({ defaultValues: { name: '' } });
  return (
    <form.AppForm>
      <form.SubmitButton label="Save" pendingLabel="Saving…" />
    </form.AppForm>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const required = ({ value }: { value: string }) => (value ? undefined : 'Enter a name.');

function ValidatedFixture({ description }: { description?: string }) {
  const form = useAppForm({ defaultValues: { username: '' } });
  return (
    <form.AppForm>
      <form.AppField name="username" validators={{ onChange: required }}>
        {(field) => <field.TextField label="Username" description={description} />}
      </form.AppField>
      <button type="button" onClick={() => void form.handleSubmit()}>
        Save
      </button>
    </form.AppForm>
  );
}

function ValidatedCheckboxFixture() {
  const form = useAppForm({ defaultValues: { agreed: false } });
  return (
    <form.AppForm>
      <form.AppField
        name="agreed"
        validators={{ onBlur: ({ value }) => (value ? undefined : 'Tick this box.') }}
      >
        {(field) => <field.CheckboxField label="Agree" description="Read our terms first" />}
      </form.AppField>
    </form.AppForm>
  );
}

describe('field wiring', () => {
  it('describes the control by its help until an error shows', () => {
    render(<ValidatedFixture description="Your display name" />);
    const input = screen.getByLabelText('Username');
    expect(input).toHaveAccessibleDescription('Your display name');
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('holds the error during first typing, then shows it on blur', async () => {
    render(<ValidatedFixture description="Your display name" />);
    const input = screen.getByLabelText('Username');
    fireEvent.change(input, { target: { value: 'k' } });
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(input).not.toHaveAttribute('aria-invalid');

    fireEvent.blur(input);
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a name.');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'username-error');
    expect(input).toHaveAccessibleDescription('Enter a name.');
  });

  it('clears the error as soon as the value is valid', async () => {
    render(<ValidatedFixture />);
    const input = screen.getByLabelText('Username');
    fireEvent.change(input, { target: { value: 'k' } });
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    await screen.findByRole('alert');
    fireEvent.change(input, { target: { value: 'kai' } });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).not.toHaveAttribute('aria-describedby');
  });

  it('shows the error after a submit, with no blur at all', async () => {
    render(<ValidatedFixture />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a name.');
  });

  // The description and error used to sit beside the label as flex siblings.
  it('stacks a checkbox label, help and error in one column beside the box', async () => {
    render(<ValidatedCheckboxFixture />);
    const box = screen.getByRole('checkbox');
    const column = screen.getByText('Read our terms first').parentElement;
    expect(column).toHaveAttribute('data-slot', 'field-content');
    expect(column).toContainElement(screen.getByText('Agree'));
    expect(box).toHaveAccessibleDescription('Read our terms first');

    fireEvent.blur(box);
    expect(await screen.findByRole('alert')).toHaveTextContent('Tick this box.');
    expect(column).toContainElement(screen.getByRole('alert'));
    expect(box).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('TextField', () => {
  it('renders label and input', () => {
    render(<TextFieldFixture />);
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter username')).toBeInTheDocument();
  });

  it('reflects value changes', () => {
    render(<TextFieldFixture />);
    const input = screen.getByLabelText('Username');
    fireEvent.change(input, { target: { value: 'kai' } });
    expect(input).toHaveValue('kai');
  });

  it('renders description when provided', () => {
    render(<TextFieldFixture description="Your display name" />);
    expect(screen.getByText('Your display name')).toBeInTheDocument();
  });
});

describe('TextareaField', () => {
  it('renders label and textarea', () => {
    render(<TextareaFieldFixture />);
    expect(screen.getByLabelText('Bio')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Tell us about yourself')).toBeInTheDocument();
  });

  it('reflects value changes', () => {
    render(<TextareaFieldFixture />);
    const textarea = screen.getByLabelText('Bio');
    fireEvent.change(textarea, { target: { value: 'I build agents.' } });
    expect(textarea).toHaveValue('I build agents.');
  });

  it('renders description when provided', () => {
    render(<TextareaFieldFixture description="Shown on your profile" />);
    expect(screen.getByText('Shown on your profile')).toBeInTheDocument();
  });
});

describe('SelectField', () => {
  it('renders label', () => {
    render(<SelectFieldFixture />);
    expect(screen.getByText('Role')).toBeInTheDocument();
  });

  it('renders description when provided', () => {
    render(<SelectFieldFixture description="Choose your access level" />);
    expect(screen.getByText('Choose your access level')).toBeInTheDocument();
  });
});

describe('SwitchField', () => {
  it('renders label and switch', () => {
    render(<SwitchFieldFixture />);
    expect(screen.getByText('Enable feature')).toBeInTheDocument();
    expect(screen.getByRole('switch')).toBeInTheDocument();
  });

  it('starts unchecked with default false', () => {
    render(<SwitchFieldFixture />);
    expect(screen.getByRole('switch')).not.toBeChecked();
  });

  it('renders description when provided', () => {
    render(<SwitchFieldFixture description="Activates the feature flag" />);
    expect(screen.getByText('Activates the feature flag')).toBeInTheDocument();
  });
});

describe('CheckboxField', () => {
  it('renders label and checkbox', () => {
    render(<CheckboxFieldFixture />);
    expect(screen.getByText('I agree to the terms')).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
  });

  it('starts unchecked with default false', () => {
    render(<CheckboxFieldFixture />);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('renders description when provided', () => {
    render(<CheckboxFieldFixture description="Read our terms first" />);
    expect(screen.getByText('Read our terms first')).toBeInTheDocument();
  });
});

describe('PasswordField', () => {
  it('renders label and password input', () => {
    render(<PasswordFieldFixture />);
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter password')).toHaveAttribute('type', 'password');
  });

  it('reflects value changes', () => {
    render(<PasswordFieldFixture />);
    const input = screen.getByPlaceholderText('Enter password');
    fireEvent.change(input, { target: { value: 'secret123' } });
    expect(input).toHaveValue('secret123');
  });

  it('renders description when provided', () => {
    render(<PasswordFieldFixture description="Must be at least 8 characters" />);
    expect(screen.getByText('Must be at least 8 characters')).toBeInTheDocument();
  });
});

describe('SubmitButton', () => {
  it('renders submit button with label', () => {
    render(<SubmitButtonFixture />);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('has type submit', () => {
    render(<SubmitButtonFixture />);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('type', 'submit');
  });
});
