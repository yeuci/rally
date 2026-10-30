import { cn } from '@/lib/utils';
import { Platform, TextInput } from 'react-native';

/**
 * Text input. Focus ring: the neutral `ring` border over a faint `field-focus` fill (Uniwind's TextInput tracks focus
 * for `focus:` on native). `invalid` draws the destructive border.
 */
function Input({
  className,
  placeholderTextColorClassName,
  invalid,
  ...props
}: React.ComponentProps<typeof TextInput> & { invalid?: boolean }) {
  return (
    <TextInput
      className={cn(
        'border-input bg-card text-foreground flex h-12 w-full min-w-0 flex-row items-center rounded-lg border px-4 py-1 text-base leading-5',
        'focus:border-ring focus:bg-field-focus',
        invalid && 'border-destructive focus:border-destructive',
        props.editable === false &&
          cn(
            'opacity-50',
            Platform.select({ web: 'disabled:pointer-events-none disabled:cursor-not-allowed' })
          ),
        Platform.select({
          web: cn(
            'placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground outline-none transition-[color,box-shadow] md:text-sm',
            'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
            'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive'
          ),
        }),
        className
      )}
      placeholderTextColorClassName={cn('accent-muted-foreground', placeholderTextColorClassName)}
      selectionColorClassName="accent-ring"
      cursorColorClassName="accent-foreground"
      {...props}
    />
  );
}

export { Input };
