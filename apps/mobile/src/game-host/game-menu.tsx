import { PROFILE_COLUMNS } from '@rally/db';
import type { GameSetting, GameSettingValue, MenuPlayer } from '@rally/protocol';
import { useQuery } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { Image as ExpoImage } from 'expo-image';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  LogOutIcon,
  PlayIcon,
  ShareIcon,
  XIcon,
} from 'lucide-react-native';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { BackHandler, Pressable, ScrollView, Share, StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScopedTheme } from 'uniwind';
import { FriendButtons } from '@/components/rally/friend-button';
import { LogoMark } from '@/components/rally/logo';
import { ProfileAvatar } from '@/components/rally/profile-avatar';
import { Segmented } from '@/components/rally/segmented';
import { Slider } from '@/components/rally/slider';
import { Icon } from '@/components/ui/icon';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { BRAND } from '@/lib/brand';
import { useFriendship } from '@/lib/friends';
import { formatJoinCode, roomCodeShareMessage, spokenJoinCode } from '@/lib/join-code-input';
import { supabase } from '@/lib/supabase';
import { showToast } from '@/lib/toast';
import type { MenuView, SettingsView } from './controller';
import {
  GRAPHICS_CHOICES,
  STICK_OPACITY,
  STICK_SIZE,
  netBars,
  type GraphicsChoice,
  type NetStatus,
  type SettingsPatch,
} from './settings';

/**
 * The host's game menu, Roblox-style: a dark translucent panel over the dimmed game with pill tabs (People when the
 * game is multiplayer, Settings, How to play), Leave game and Resume. Always dark (it sits on the game, whatever the
 * app's theme). Works in landscape (most games) and portrait, inside the safe area.
 *
 * - **Settings**: the platform ones (volume master / music / effects, graphics Auto / Low / Medium / High, haptics),
 *   then the game's own from `menu.define`. Sliders report while dragging (`final` false) and once on release.
 * - **How to play**: the game's help entries, or a short empty state.
 * - **People**: `menu.players` rows; rows with a Rally user id open a small profile peek with Add friend (no
 *   navigation away from the game). The private room's code with Copy / Share when the play screen knows it.
 *
 * GameHost mounts it while `view.menuOpen`; Android back closes a sub-view (the peek, the leave confirmation) first.
 */

const NEVER = ReduceMotion.Never;
const WHITE = '#FFFFFF';
const SLIDER_COLORS = { track: 'rgba(255,255,255,0.18)', fill: WHITE, thumb: WHITE };

type Tab = 'people' | 'settings' | 'help';

export interface GameMenuProps {
  title: string | null;
  iconUri?: string | null;
  menu: MenuView;
  settings: SettingsView;
  leaving: boolean;
  /** The private room's join code, when the play screen knows it. */
  roomCode?: string | null;
  onResume: () => void;
  /** Leave game (confirmed in the menu). */
  onLeave: () => void;
  onChange: (patch: SettingsPatch, final: boolean) => void;
  /** The game's connection (`net.status`): ping bars in the header. */
  net?: NetStatus | null;
  /** The tab to open on; default People in a match with others, else Settings. */
  initialTab?: GameMenuTab;
  /** "Tuck menu button to the side" (menu-button.tsx); the switch is hidden without a handler. */
  buttonTucked?: boolean;
  onButtonTuckedChange?: (tucked: boolean) => void;
}

export type GameMenuTab = Tab;

const GRAPHICS_LABEL: Record<GraphicsChoice, string> = { auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High' };

export function GameMenu(props: GameMenuProps) {
  const { title, iconUri, menu, settings, leaving, roomCode, net, onResume, onLeave, onChange, initialTab } = props;
  const { buttonTucked = false, onButtonTuckedChange } = props;
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const multiplayer = menu.players.length > 0 || !!roomCode;
  const [tab, setTab] = useState<Tab>(initialTab ?? (multiplayer && menu.players.length > 1 ? 'people' : 'settings'));
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [peek, setPeek] = useState<MenuPlayer | null>(null);
  const name = title?.trim() || 'the game';

  // Android back closes a sub-view before the menu itself (GameHost's handler runs after this one).
  useEffect(() => {
    if (!confirmLeave && !peek) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (peek) setPeek(null);
      else setConfirmLeave(false);
      return true;
    });
    return () => sub.remove();
  }, [confirmLeave, peek]);

  const tabs = useMemo(
    () => [
      ...(multiplayer ? [{ value: 'people' as const, label: 'People' }] : []),
      { value: 'settings' as const, label: 'Settings' },
      { value: 'help' as const, label: 'How to play' },
    ],
    [multiplayer],
  );
  const shownTab: Tab = tab === 'people' && !multiplayer ? 'settings' : tab;

  const panelWidth = Math.min(width - insets.left - insets.right - 24, landscape ? 720 : 560);
  const panelHeight = Math.min(
    height - Math.max(insets.top, 12) - Math.max(insets.bottom, 12) - 12,
    landscape ? 560 : 680,
  );

  return (
    <ScopedTheme theme="dark">
      <View style={StyleSheet.absoluteFill} accessibilityViewIsModal>
        <Animated.View
          entering={FadeIn.duration(180).reduceMotion(NEVER)}
          exiting={FadeOut.duration(160).reduceMotion(NEVER)}
          style={[StyleSheet.absoluteFill, styles.backdrop]}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={onResume}
            accessibilityLabel="Resume"
            accessibilityRole="button"
          />
        </Animated.View>
        <View style={styles.center} pointerEvents="box-none">
          <Animated.View
            entering={FadeIn.duration(180).reduceMotion(NEVER)}
            exiting={FadeOut.duration(140).reduceMotion(NEVER)}
            style={[styles.panel, { width: panelWidth, maxHeight: panelHeight }]}
          >
            {/* Header: the game, the tabs (beside it in landscape), and a close button. */}
            <View style={[styles.header, landscape && styles.headerRow]}>
              <View style={styles.titleRow}>
                {iconUri ? (
                  <ExpoImage
                    source={{ uri: iconUri }}
                    style={styles.icon}
                    contentFit="cover"
                    accessibilityIgnoresInvertColors
                  />
                ) : (
                  <View style={[styles.icon, styles.iconFallback]}>
                    <LogoMark size={22} color={WHITE} />
                  </View>
                )}
                <Text className="text-white" style={styles.title} numberOfLines={1} accessibilityRole="header">
                  {title?.trim() || 'Game menu'}
                </Text>
                {net ? <PingBars net={net} /> : null}
                {!landscape ? <CloseButton onPress={onResume} /> : null}
              </View>
              <View style={[styles.tabsRow, landscape && styles.tabsRowLandscape]}>
                <Segmented
                  options={tabs}
                  value={shownTab}
                  onChange={(t) => {
                    setPeek(null);
                    setTab(t);
                  }}
                  size="sm"
                  accessibilityLabel="Menu sections"
                />
                {landscape ? <CloseButton onPress={onResume} /> : null}
              </View>
            </View>

            <ScrollView
              style={styles.body}
              contentContainerStyle={styles.bodyContent}
              showsVerticalScrollIndicator={false}
            >
              {shownTab === 'settings' ? (
                <SettingsTab
                  title={name}
                  menu={menu}
                  settings={settings}
                  onChange={onChange}
                  buttonTucked={buttonTucked}
                  onButtonTuckedChange={onButtonTuckedChange}
                />
              ) : shownTab === 'help' ? (
                <HelpTab menu={menu} />
              ) : peek ? (
                <PlayerPeek player={peek} onBack={() => setPeek(null)} />
              ) : (
                <PeopleTab players={menu.players} roomCode={roomCode ?? null} gameTitle={name} onPeek={setPeek} />
              )}
            </ScrollView>

            <View style={styles.footer}>
              {confirmLeave ? (
                <>
                  <Text className="text-white" style={styles.confirmText} numberOfLines={1}>
                    {leaving ? `Leaving ${name}…` : `Leave ${name}?`}
                  </Text>
                  {!leaving ? <MenuButton label="Stay" onPress={() => setConfirmLeave(false)} /> : null}
                  <MenuButton
                    label={leaving ? 'Close now' : 'Leave'}
                    tone="danger"
                    icon={LogOutIcon}
                    onPress={onLeave}
                  />
                </>
              ) : (
                <>
                  <MenuButton label="Leave game" icon={LogOutIcon} onPress={() => setConfirmLeave(true)} />
                  <View style={styles.flex} />
                  <MenuButton label="Resume" tone="primary" icon={PlayIcon} onPress={onResume} />
                </>
              )}
            </View>
          </Animated.View>
        </View>
      </View>
    </ScopedTheme>
  );
}

const TONE: Record<ReturnType<typeof netBars>['tone'], string> = {
  good: '#4ADE80',
  fair: '#FBBF24',
  poor: '#F87171',
  offline: '#F87171',
};

/** Connection quality in the menu header: four bars and the round-trip time ("48 ms"), or Reconnecting / Offline. */
export function PingBars({ net }: { net: NetStatus }) {
  const { bars, tone, label } = netBars(net);
  const color = TONE[tone];
  return (
    <View style={styles.ping} accessible accessibilityLabel={`Connection: ${label}`}>
      <View style={styles.bars}>
        {[1, 2, 3, 4].map((i) => (
          <View
            key={i}
            style={[styles.bar, { height: 3 + i * 3, backgroundColor: i <= bars ? color : 'rgba(255,255,255,0.2)' }]}
          />
        ))}
      </View>
      <Text style={[styles.pingText, { color: tone === 'good' ? 'rgba(255,255,255,0.7)' : color }]}>{label}</Text>
    </View>
  );
}

function IconButton({ label, icon, onPress }: { label: string; icon: typeof XIcon; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
    >
      <Icon as={icon} size={18} color={WHITE} />
    </Pressable>
  );
}

function CloseButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Close menu"
      hitSlop={8}
      style={({ pressed }) => [styles.close, pressed && styles.pressed]}
    >
      <Icon as={XIcon} size={16} color={WHITE} />
    </Pressable>
  );
}

function MenuButton({
  label,
  icon,
  tone = 'plain',
  onPress,
}: {
  label: string;
  icon?: typeof XIcon;
  tone?: 'plain' | 'primary' | 'danger';
  onPress: () => void;
}) {
  const color = tone === 'primary' ? BRAND.base : WHITE;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.button,
        tone === 'primary' && styles.buttonPrimary,
        tone === 'danger' && styles.buttonDanger,
        pressed && styles.pressed,
      ]}
    >
      {icon ? <Icon as={icon} size={16} color={color} /> : null}
      <Text style={[styles.buttonText, { color }]}>{label}</Text>
    </Pressable>
  );
}

// --- Settings ---------------------------------------------------------------------------------------------------

function SettingsTab({
  title,
  menu,
  settings,
  onChange,
  buttonTucked,
  onButtonTuckedChange,
}: {
  title: string;
  menu: MenuView;
  settings: SettingsView;
  onChange: (patch: SettingsPatch, final: boolean) => void;
  buttonTucked: boolean;
  onButtonTuckedChange?: (tucked: boolean) => void;
}) {
  const { platform } = settings;
  const volume = (key: keyof typeof platform.volume, label: string) => (
    <SliderRow
      key={key}
      label={label}
      value={platform.volume[key]}
      min={0}
      max={1}
      step={0.05}
      format={(v) => `${Math.round(v * 100)}%`}
      onChange={(v, final) => onChange({ volume: { [key]: v } }, final)}
    />
  );
  return (
    <View style={styles.sections}>
      <Section title="Sound">
        {volume('master', 'Master volume')}
        {volume('music', 'Music')}
        {volume('effects', 'Effects')}
      </Section>
      <Section title="Graphics">
        <Segmented
          options={GRAPHICS_CHOICES.map((g) => ({ value: g, label: GRAPHICS_LABEL[g] }))}
          value={platform.graphics}
          onChange={(g) => onChange({ graphics: g }, true)}
          size="sm"
          accessibilityLabel="Graphics quality"
        />
        <Text className="text-white" style={styles.caption}>
          {platform.graphics === 'auto'
            ? `Auto picks ${GRAPHICS_LABEL[settings.auto]} on this device.`
            : 'Lower settings run smoother and save battery.'}
        </Text>
      </Section>
      <Section title="Controls">
        <ToggleRow
          label="Left-handed"
          caption="Swap the move and aim sticks"
          value={platform.controls.swapSticks}
          onChange={(v) => onChange({ controls: { swapSticks: v } }, true)}
        />
        <SliderRow
          label="Stick size"
          value={platform.controls.stickSize}
          min={STICK_SIZE.min}
          max={STICK_SIZE.max}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v, final) => onChange({ controls: { stickSize: v } }, final)}
        />
        <SliderRow
          label="Stick opacity"
          value={platform.controls.stickOpacity}
          min={STICK_OPACITY.min}
          max={STICK_OPACITY.max}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v, final) => onChange({ controls: { stickOpacity: v } }, final)}
        />
        <ToggleRow
          label="Aim assist"
          caption="A gentle snap toward targets in games that aim"
          value={platform.controls.aimAssist}
          onChange={(v) => onChange({ controls: { aimAssist: v } }, true)}
        />
      </Section>
      <Section title="Haptics">
        <ToggleRow
          label="Vibration"
          caption="Taps and rumbles from the game"
          value={platform.haptics}
          onChange={(v) => onChange({ haptics: v }, true)}
        />
      </Section>
      {onButtonTuckedChange ? (
        <Section title="Menu button">
          <ToggleRow
            label="Tuck menu button to the side"
            caption="A slim tab on the edge; tap it to bring the button back. Drag the button to move it."
            value={buttonTucked}
            onChange={onButtonTuckedChange}
          />
        </Section>
      ) : null}
      {menu.settings.length > 0 ? (
        <Section title={title}>
          {menu.settings.map((s) => (
            <GameSettingRow
              key={s.key}
              setting={s}
              value={settings.game[s.key] ?? s.default}
              onChange={(v, final) => onChange({ game: { [s.key]: v } }, final)}
            />
          ))}
        </Section>
      ) : null}
    </View>
  );
}

function GameSettingRow({
  setting,
  value,
  onChange,
}: {
  setting: GameSetting;
  value: GameSettingValue;
  onChange: (value: GameSettingValue, final: boolean) => void;
}) {
  switch (setting.type) {
    case 'toggle':
      return <ToggleRow label={setting.label} value={value === true} onChange={(v) => onChange(v, true)} />;
    case 'slider': {
      const decimals = setting.step < 1 ? Math.min(2, String(setting.step).split('.')[1]?.length ?? 1) : 0;
      return (
        <SliderRow
          label={setting.label}
          value={typeof value === 'number' ? value : setting.default}
          min={setting.min}
          max={setting.max}
          step={setting.step}
          format={(v) => v.toFixed(decimals)}
          onChange={onChange}
        />
      );
    }
    case 'choice':
      return (
        <View style={styles.row}>
          <Text className="text-white" style={styles.rowLabel}>
            {setting.label}
          </Text>
          <Segmented
            options={setting.options}
            value={typeof value === 'string' ? value : setting.default}
            onChange={(v) => onChange(v, true)}
            size="sm"
            scrollable
            accessibilityLabel={setting.label}
          />
        </View>
      );
  }
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text className="text-white" style={styles.sectionTitle} accessibilityRole="header">
        {title}
      </Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function ToggleRow({
  label,
  caption,
  value,
  onChange,
}: {
  label: string;
  caption?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Pressable
      style={styles.toggleRow}
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={label}
    >
      <View style={styles.flex}>
        <Text className="text-white" style={styles.rowLabel}>
          {label}
        </Text>
        {caption ? (
          <Text className="text-white" style={styles.caption}>
            {caption}
          </Text>
        ) : null}
      </View>
      <Switch checked={value} onCheckedChange={onChange} />
    </Pressable>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number, final: boolean) => void;
}) {
  return (
    <View style={styles.sliderRow}>
      <Text className="text-white" style={[styles.rowLabel, styles.sliderLabel]} numberOfLines={2}>
        {label}
      </Text>
      <View style={styles.flex}>
        <Slider
          label={label}
          value={value}
          min={min}
          max={max}
          step={step}
          format={format}
          onChange={onChange}
          colors={SLIDER_COLORS}
        />
      </View>
      <Text className="text-white" style={[styles.value, styles.sliderValue]} numberOfLines={1}>
        {format(value)}
      </Text>
    </View>
  );
}

// --- How to play ------------------------------------------------------------------------------------------------

function HelpTab({ menu }: { menu: MenuView }) {
  if (menu.help.length === 0) {
    return (
      <Empty
        title="No guide yet"
        body={menu.defined ? 'This game teaches you as you play.' : 'This game has not added a how-to-play guide yet.'}
      />
    );
  }
  return (
    <View style={styles.helpList}>
      {menu.help.map((h, i) => (
        <View key={`${i}-${h.title}`} style={styles.helpCard}>
          <Text className="text-white" style={styles.helpTitle}>
            {h.title}
          </Text>
          <Text className="text-white" style={styles.helpText}>
            {h.text}
          </Text>
        </View>
      ))}
    </View>
  );
}

// --- People -----------------------------------------------------------------------------------------------------

function PeopleTab({
  players,
  roomCode,
  gameTitle,
  onPeek,
}: {
  players: MenuPlayer[];
  roomCode: string | null;
  gameTitle: string;
  onPeek: (p: MenuPlayer) => void;
}) {
  return (
    <View style={styles.sections}>
      {roomCode ? <RoomCodeCard code={roomCode} gameTitle={gameTitle} /> : null}
      {players.length === 0 ? (
        <Empty title="No one here yet" body="Players show up here once you are in a match." />
      ) : (
        <Section title={`In this match · ${players.length}`}>
          {players.map((p, i) => {
            const canPeek = !!p.userId && !p.you;
            return (
              <Pressable
                key={`${i}-${p.name}`}
                disabled={!canPeek}
                onPress={() => onPeek(p)}
                accessibilityRole={canPeek ? 'button' : undefined}
                accessibilityLabel={`${p.name}${p.you ? ', you' : ''}${p.detail ? `, ${p.detail}` : ''}`}
                style={({ pressed }) => [styles.playerRow, pressed && styles.pressed]}
              >
                <View style={styles.initial}>
                  <Text className="text-white" style={styles.initialText}>
                    {initialOf(p.name)}
                  </Text>
                </View>
                <Text className="text-white" style={styles.playerName} numberOfLines={1}>
                  {p.name}
                </Text>
                {p.you ? (
                  <View style={styles.youBadge}>
                    <Text style={styles.youText}>You</Text>
                  </View>
                ) : null}
                <View style={styles.flex} />
                {p.detail ? (
                  <Text className="text-white" style={styles.playerDetail} numberOfLines={1}>
                    {p.detail}
                  </Text>
                ) : null}
                {canPeek ? <Icon as={ChevronRightIcon} size={16} color="rgba(255,255,255,0.45)" /> : null}
              </Pressable>
            );
          })}
        </Section>
      )}
    </View>
  );
}

function RoomCodeCard({ code, gameTitle }: { code: string; gameTitle: string }) {
  return (
    <View style={styles.codeCard}>
      <Text className="text-white" style={styles.caption}>
        Invite friends with the room code
      </Text>
      <View style={styles.codeRow}>
        <Text
          className="text-white"
          style={[styles.code, styles.flex]}
          numberOfLines={1}
          accessibilityLabel={`Room code ${spokenJoinCode(code)}`}
        >
          {formatJoinCode(code)}
        </Text>
        <IconButton
          label="Copy the room code"
          icon={CopyIcon}
          onPress={() => {
            void Clipboard.setStringAsync(code).then(
              () => showToast('Room code copied'),
              () => {},
            );
          }}
        />
        <IconButton
          label="Share the room code"
          icon={ShareIcon}
          onPress={() => {
            Share.share({ message: roomCodeShareMessage(gameTitle, code) }).catch(() => {});
          }}
        />
      </View>
    </View>
  );
}

/** A player's small profile, inside the menu: avatar, name, and the friendship buttons (Add friend…). */
function PlayerPeek({ player, onBack }: { player: MenuPlayer; onBack: () => void }) {
  const userId = player.userId!;
  const profile = useQuery({
    queryKey: ['menu-peek', userId],
    queryFn: async () => {
      const { data, error } = await supabase.from('profiles').select(PROFILE_COLUMNS).eq('id', userId).maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  const friendship = useFriendship(userId);
  const p = profile.data;
  const handle = p?.username ? `@${p.username}` : player.name;
  return (
    <View style={styles.peek}>
      <Pressable
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel="Back to people"
        style={styles.peekBack}
        hitSlop={8}
      >
        <Icon as={ChevronLeftIcon} size={16} color={WHITE} />
        <Text className="text-white" style={styles.caption}>
          People
        </Text>
      </Pressable>
      <View style={styles.peekHead}>
        <ProfileAvatar
          profile={p ?? { username: player.name, display_name: player.name, avatar_url: null }}
          userId={userId}
          size="md"
        />
        <View style={styles.flex}>
          <Text className="text-white" style={styles.playerName} numberOfLines={1}>
            {p?.display_name || player.name}
          </Text>
          <Text className="text-white" style={styles.caption} numberOfLines={1}>
            {handle}
            {player.detail ? ` · ${player.detail}` : ''}
          </Text>
        </View>
      </View>
      {profile.isError ? (
        <Text className="text-white" style={styles.caption}>
          Could not load this profile.
        </Text>
      ) : friendship.data ? (
        <FriendButtons userId={userId} name={handle} status={friendship.data} mode="profile" />
      ) : null}
    </View>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.empty}>
      <Text className="text-white" style={styles.emptyTitle}>
        {title}
      </Text>
      <Text className="text-white" style={styles.caption}>
        {body}
      </Text>
    </View>
  );
}

function initialOf(name: string): string {
  const c = name.replace(/^guest-/i, '').trim()[0];
  return c ? c.toUpperCase() : '?';
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { backgroundColor: 'rgba(0,0,0,0.55)' },
  center: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  panel: {
    borderRadius: 24,
    backgroundColor: 'rgba(18,18,18,0.94)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.14)',
    overflow: 'hidden',
  },
  header: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10, gap: 10 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 },
  icon: { width: 30, height: 30, borderRadius: 8 },
  iconFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)' },
  title: { flexShrink: 1, flexGrow: 1, fontSize: 17, lineHeight: 22, fontWeight: '800', letterSpacing: -0.3 },
  tabsRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  tabsRowLandscape: { flexShrink: 0 },
  close: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  body: { flexGrow: 0, borderTopWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.1)' },
  bodyContent: { padding: 16 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  confirmText: { flex: 1, fontSize: 15, lineHeight: 20, fontWeight: '600' },
  button: {
    height: 40,
    paddingHorizontal: 16,
    borderRadius: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  buttonPrimary: { backgroundColor: WHITE },
  buttonDanger: { backgroundColor: 'rgba(255,100,103,0.85)' },
  buttonText: { fontSize: 14, lineHeight: 18, fontWeight: '700' },
  pressed: { opacity: 0.7 },
  sections: { gap: 18 },
  section: { gap: 8 },
  sectionTitle: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    opacity: 0.5,
  },
  sectionBody: { gap: 12 },
  row: { gap: 8 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 36 },
  rowLabel: { fontSize: 15, lineHeight: 20, fontWeight: '500' },
  value: { fontSize: 13, lineHeight: 18, opacity: 0.55, fontVariant: ['tabular-nums'] },
  caption: { fontSize: 13, lineHeight: 18, opacity: 0.55 },
  helpList: { gap: 10 },
  helpCard: { padding: 14, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.06)', gap: 4 },
  helpTitle: { fontSize: 15, lineHeight: 20, fontWeight: '700' },
  helpText: { fontSize: 14, lineHeight: 20, opacity: 0.75 },
  playerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  initial: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  initialText: { fontSize: 14, lineHeight: 18, fontWeight: '700' },
  playerName: { flexShrink: 1, fontSize: 15, lineHeight: 20, fontWeight: '600' },
  playerDetail: { fontSize: 13, lineHeight: 18, opacity: 0.55, fontVariant: ['tabular-nums'] },
  youBadge: { paddingHorizontal: 7, paddingVertical: 1, borderRadius: 8, backgroundColor: WHITE },
  youText: { fontSize: 11, lineHeight: 16, fontWeight: '800', color: BRAND.base },
  codeCard: { gap: 4, padding: 12, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.06)' },
  codeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ping: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4 },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 15 },
  bar: { width: 3, borderRadius: 1 },
  pingText: { fontSize: 12, lineHeight: 16, fontWeight: '600', fontVariant: ['tabular-nums'] },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  sliderRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 36 },
  sliderLabel: { width: 128 },
  sliderValue: { width: 44, textAlign: 'right' },
  code: { fontSize: 20, lineHeight: 26, fontWeight: '800', letterSpacing: 2, fontVariant: ['tabular-nums'] },
  peek: { gap: 14 },
  peekBack: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' },
  peekHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  empty: { paddingVertical: 24, alignItems: 'center', gap: 4 },
  emptyTitle: { fontSize: 16, lineHeight: 22, fontWeight: '700' },
});
