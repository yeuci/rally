import { Input } from '@/components/ui/input';
import type { UsernameStatus } from '@/lib/auth/use-username-availability';
import { FormField, type FieldTone } from './form-field';

const TONE: Record<UsernameStatus, FieldTone> = {
  empty: 'muted',
  invalid: 'error',
  checking: 'muted',
  available: 'success',
  unavailable: 'error',
  unchanged: 'muted',
  error: 'muted',
};

/** Username input with live format + availability feedback; pair it with `useUsernameAvailability`. */
export function UsernameField({
  value,
  onChangeText,
  current,
  status,
  message,
  autoFocus,
}: {
  value: string;
  onChangeText: (v: string) => void;
  current?: string | null;
  status: UsernameStatus;
  message: string | null;
  autoFocus?: boolean;
}) {
  return (
    <FormField
      id="username"
      label="Username"
      hint={message ?? (current ? null : '3–20 letters, numbers or underscores. This is how friends find you.')}
      tone={TONE[status]}
    >
      <Input
        aria-labelledby="username"
        value={value}
        onChangeText={(v) => onChangeText(v.replace(/\s/g, ''))}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="username-new"
        textContentType="username"
        maxLength={20}
        autoFocus={autoFocus}
        placeholder="your_name"
        invalid={TONE[status] === 'error'}
      />
    </FormField>
  );
}
