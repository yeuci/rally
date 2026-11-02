import * as Clipboard from 'expo-clipboard';
import { ChevronDownIcon, type LucideIcon } from 'lucide-react-native';
import { useCallback, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { ConfirmDialog } from '@/components/rally/confirm-dialog';
import { SettingsRow } from '@/components/rally/settings-rows';
import { Icon } from '@/components/ui/icon';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import { showToast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/**
 * Building blocks of the Developer page (app/dev/index.tsx): a collapsible section, the confirmation every
 * destructive action asks for, copy-to-clipboard with a toast, and rows for a SettingsGroup (components/rally/
 * settings-rows.tsx) that copy their value or hold custom content.
 */

/** Which sections are open, for the rest of the run (the page remounts each time it is opened). */
const openSections = new Map<string, boolean>();

/**
 * A titled section that folds away. Its content mounts only while it is open, so a closed section costs nothing (no
 * health check, no log polling).
 */
export function DevSection({
  id,
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  id: string;
  title: string;
  /** Shown beside the title while the section is closed. */
  summary?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => openSections.get(id) ?? defaultOpen);
  const toggle = () => {
    openSections.set(id, !open);
    setOpen(!open);
  };
  return (
    <View className="gap-3">
      <Disclosure open={open} onToggle={toggle} label={title} summary={summary} heading />
      {open ? <View className="gap-5">{children}</View> : null}
    </View>
  );
}

/** A tappable title with a chevron that turns when open: a section's header, or "Advanced" inside one. */
export function Disclosure({
  open,
  onToggle,
  label,
  summary,
  heading = false,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  summary?: string;
  heading?: boolean;
}) {
  return (
    <TapPressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded: open }}
      hitSlop={6}
      className="min-h-9 flex-row items-center gap-2 px-1 active:opacity-70"
    >
      <Text
        className={cn(
          'shrink grow',
          heading ? 'text-[19px] font-bold leading-6 tracking-tight' : 'text-[15px] font-semibold',
        )}
        role={heading ? 'heading' : undefined}
        numberOfLines={1}
      >
        {label}
      </Text>
      {summary && !open ? (
        <Text variant="muted" className="shrink text-[13px]" numberOfLines={1}>
          {summary}
        </Text>
      ) : null}
      <View style={{ transform: [{ rotate: open ? '0deg' : '-90deg' }] }}>
        <Icon as={ChevronDownIcon} className="text-muted-foreground size-5" />
      </View>
    </TapPressable>
  );
}

/** The icon tile of a settings row (components/rally/settings-rows.tsx draws the same one). */
export function DevRowIcon({ icon }: { icon: LucideIcon }) {
  return (
    <View className="bg-muted size-9 items-center justify-center rounded-xl">
      <Icon as={icon} className="text-secondary-foreground size-[18px]" />
    </View>
  );
}

/** A read-only settings row: tapping it copies the value (or `copy`, when the row shows a shortened one). */
export function CopyRow({
  icon,
  label,
  value,
  copy,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  copy?: string;
}) {
  return (
    <SettingsRow
      icon={icon}
      label={label}
      value={value}
      hint="Copies the value"
      chevron={false}
      onPress={() => copyToClipboard(label.toLowerCase(), copy ?? value)}
    />
  );
}

/** A settings-style row with custom content on the right (a status, a button). */
export function CustomRow({ icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
  return (
    <View className="min-h-[60px] flex-row items-center gap-3.5 px-4 py-2.5">
      <DevRowIcon icon={icon} />
      <Text className="text-[15px] font-medium" numberOfLines={1}>
        {label}
      </Text>
      <View className="flex-1 flex-row items-center justify-end gap-2">{children}</View>
    </View>
  );
}

/** Copies `value` and says so in a toast. */
export function copyToClipboard(label: string, value: string): void {
  Clipboard.setStringAsync(value).then(
    () => showToast(`Copied ${label}`),
    () => showToast(`Couldn't copy ${label}`),
  );
}

export interface ConfirmRequest {
  title: string;
  body: string;
  /** The confirming button's label ("Clear", "Reset"). */
  action: string;
  /** Paints the button in the destructive colour (default true: these are resets). */
  destructive?: boolean;
  onConfirm: () => void;
}

/**
 * One ConfirmDialog for a section: `ask(request)` opens it; the action runs only when confirmed. The last request
 * stays in state while the dialog closes, so its text does not blank out during the exit animation.
 */
export function useConfirm(): { ask: (request: ConfirmRequest) => void; dialog: ReactNode } {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const [open, setOpen] = useState(false);
  const ask = useCallback((next: ConfirmRequest) => {
    setRequest(next);
    setOpen(true);
  }, []);
  const dialog = request ? (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      title={request.title}
      body={request.body}
      action={request.action}
      destructive={request.destructive ?? true}
      onConfirm={request.onConfirm}
    />
  ) : null;
  return { ask, dialog };
}
