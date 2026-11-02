import { isRunningInExpoGo } from 'expo';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import {
  ActivityIcon,
  BoxIcon,
  CloudIcon,
  CodeIcon,
  FingerprintIcon,
  FrameIcon,
  LayersIcon,
  RefreshCwIcon,
  RulerIcon,
  ServerIcon,
  SmartphoneIcon,
  UserIcon,
} from 'lucide-react-native';
import { ActivityIndicator, PixelRatio, Platform, View } from 'react-native';
import { SettingsGroup } from '@/components/rally/settings-rows';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { Text } from '@/components/ui/text';
import { config } from '@/config';
import { isTablet } from '@/game-host/orientation';
import { useSession } from '@/lib/auth/session';
import {
  accountLabel,
  buildLabel,
  deviceLabel,
  healthSummary,
  hostOf,
  insetsLabel,
  osLabel,
  sizeLabel,
  versionLabel,
} from '@/lib/dev-env-model';
import { usePalette } from '@/lib/use-palette';
import { useProfile } from '@/lib/profile';
import { useServerHealth } from '@/lib/use-server-health';
import { cn } from '@/lib/utils';
import { useViewport } from '@/lib/viewport';
import { CopyRow, CustomRow, DevSection } from './dev-section';

/**
 * Environment: what this build is (dev or release JS, Expo Go or a build, the version), what it talks to (the
 * Supabase project's host, the game server and a live health check, who is signed in) and the device it runs on
 * (phone or tablet, OS, window and safe area). Read-only; every row copies its value. No keys are ever shown.
 */
export function EnvironmentSection() {
  return (
    <DevSection id="environment" title="Environment" defaultOpen>
      <BuildGroup />
      <ServicesGroup />
      <DeviceGroup />
    </DevSection>
  );
}

function BuildGroup() {
  return (
    <SettingsGroup title="Build">
      <CopyRow icon={CodeIcon} label="Build" value={buildLabel(__DEV__, isRunningInExpoGo())} />
      <Separator className="ml-16" />
      <CopyRow
        icon={BoxIcon}
        label="Version"
        value={versionLabel(config.appVersion, Constants.expoConfig?.sdkVersion)}
      />
    </SettingsGroup>
  );
}

function ServicesGroup() {
  const { signedIn, userId } = useSession();
  const profile = useProfile();
  return (
    <SettingsGroup
      title="Services"
      footer="Health asks the game server's /healthz (OK, round trip, server version) and /versions (its room types)."
    >
      <CopyRow icon={CloudIcon} label="Supabase" value={hostOf(config.supabaseUrl) ?? 'Not configured'} />
      <Separator className="ml-16" />
      <CopyRow icon={ServerIcon} label="Game server" value={config.colyseusUrl} />
      <Separator className="ml-16" />
      <HealthRows url={config.colyseusUrl} />
      <Separator className="ml-16" />
      <CopyRow
        icon={UserIcon}
        label="Account"
        value={accountLabel({ signedIn, userId, username: profile.data?.username })}
      />
      {userId ? (
        <>
          <Separator className="ml-16" />
          <CopyRow icon={FingerprintIcon} label="User id" value={userId} />
        </>
      ) : null}
    </SettingsGroup>
  );
}

/**
 * The live check of `url` with its Refresh button, and the room types the server lists. Shared with the launcher's
 * Advanced fields, which may point at another server.
 */
export function HealthRows({ url, label = 'Health' }: { url: string; label?: string }) {
  const health = useServerHealth(url);
  const palette = usePalette();
  const h = health.data;
  const busy = health.isFetching;
  const summary = h ? healthSummary(h) : busy ? 'Checking…' : 'Not checked';
  return (
    <>
      <CustomRow icon={ActivityIcon} label={label}>
        <View
          className={cn('size-2 rounded-full', !h ? 'bg-muted-foreground' : h.ok ? 'bg-emerald-500' : 'bg-destructive')}
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
        <Text
          variant="muted"
          className={cn('shrink text-[15px]', h && !h.ok && 'text-destructive')}
          numberOfLines={2}
          accessibilityLiveRegion="polite"
        >
          {summary}
        </Text>
        <Button
          size="icon"
          variant="ghost"
          className="size-9"
          onPress={() => void health.refetch()}
          disabled={busy}
          accessibilityLabel={`Refresh ${label.toLowerCase()}`}
        >
          {busy ? (
            <ActivityIndicator size="small" color={palette.mutedForeground} />
          ) : (
            <Icon as={RefreshCwIcon} className="text-foreground size-[18px]" />
          )}
        </Button>
      </CustomRow>
      {h?.rooms ? (
        <>
          <Separator className="ml-16" />
          <CopyRow icon={LayersIcon} label="Rooms" value={h.rooms.length ? h.rooms.join(', ') : 'None'} />
        </>
      ) : null}
    </>
  );
}

function DeviceGroup() {
  const { width, height, insets } = useViewport();
  return (
    <SettingsGroup title="Device">
      <CopyRow icon={SmartphoneIcon} label="Device" value={deviceLabel(isTablet(), Device.modelName)} />
      <Separator className="ml-16" />
      <CopyRow
        icon={CodeIcon}
        label="OS"
        value={osLabel(Platform.OS, Device.osVersion, Platform.Version, Device.osName)}
      />
      <Separator className="ml-16" />
      <CopyRow icon={RulerIcon} label="Window" value={`${sizeLabel(width, height)} · @${PixelRatio.get()}x`} />
      <Separator className="ml-16" />
      <CopyRow icon={FrameIcon} label="Safe area" value={insetsLabel(insets)} />
    </SettingsGroup>
  );
}
