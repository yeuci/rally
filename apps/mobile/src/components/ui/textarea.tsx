import { cn } from '@/lib/utils';
import { Platform, TextInput } from 'react-native';
import { useKeyboardAppearance } from '@/lib/use-palette';

function Textarea({
  className,
  multiline = true,
  numberOfLines = Platform.select({ web: 2, native: 8 }), // On web, numberOfLines also determines initial height. On native, it determines the maximum height.
  placeholderTextColorClassName,
  ...props
}: React.ComponentProps<typeof TextInput>) {
  const keyboardAppearance = useKeyboardAppearance();
  return (
    <TextInput
      className={cn(
        'text-foreground border-input bg-card flex min-h-24 w-full flex-row rounded-lg border px-4 py-3 text-base md:text-sm',
        'focus:border-ring focus:bg-field-focus',
        Platform.select({
          web: 'placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive field-sizing-content resize-y outline-none transition-[color,box-shadow] focus-visible:ring-[3px] disabled:cursor-not-allowed',
        }),
        props.editable === false && 'opacity-50',
        className
      )}
      placeholderTextColorClassName={cn('accent-muted-foreground', placeholderTextColorClassName)}
      selectionColorClassName="accent-ring"
      cursorColorClassName="accent-foreground"
      keyboardAppearance={keyboardAppearance}
      multiline={multiline}
      numberOfLines={numberOfLines}
      textAlignVertical="top"
      {...props}
    />
  );
}

export { Textarea };
