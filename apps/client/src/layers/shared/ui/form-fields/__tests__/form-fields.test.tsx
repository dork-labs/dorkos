/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
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
      <form.SubmitButton label="Save" pendingLabel="Saving..." />
    </form.AppForm>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
