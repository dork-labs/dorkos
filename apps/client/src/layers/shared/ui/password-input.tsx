import * as React from 'react';
import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input, type InputProps } from './input';
import { Button } from './button';
import { cn } from '@/layers/shared/lib';

interface PasswordInputProps extends Omit<InputProps, 'type'> {
  /** Controlled visibility state. When provided, component is controlled. */
  showPassword?: boolean;
  /** Callback when visibility toggle is clicked (controlled mode). */
  onShowPasswordChange?: (show: boolean) => void;
  /** Initial visibility state for uncontrolled mode. Defaults to false. */
  visibleByDefault?: boolean;
}

/**
 * Password input with eye/eye-off visibility toggle.
 *
 * Supports both controlled (`showPassword` + `onShowPasswordChange`) and
 * uncontrolled (`visibleByDefault`) modes.
 */
function PasswordInput({
  className,
  showPassword: controlledShow,
  onShowPasswordChange,
  visibleByDefault = false,
  ...props
}: PasswordInputProps) {
  const [internalShow, setInternalShow] = useState(visibleByDefault);
  const isControlled = controlledShow !== undefined;
  const isVisible = isControlled ? controlledShow : internalShow;

  const toggleVisibility = () => {
    if (isControlled) {
      onShowPasswordChange?.(!controlledShow);
    } else {
      setInternalShow((prev) => !prev);
    }
  };

  return (
    <div className="relative">
      <Input type={isVisible ? 'text' : 'password'} className={cn('pr-10', className)} {...props} />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:text-foreground absolute top-0 right-0 h-full px-3 hover:bg-transparent"
        onClick={toggleVisibility}
        aria-label={isVisible ? 'Hide password' : 'Show password'}
      >
        {isVisible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </Button>
    </div>
  );
}

export { PasswordInput };
export type { PasswordInputProps };
