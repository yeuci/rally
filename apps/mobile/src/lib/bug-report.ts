import { BUG_REPORTS_BUCKET } from '@rally/db';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import { useSyncExternalStore } from 'react';
import { Dimensions, PixelRatio, Platform } from 'react-native';
import { captureScreen } from 'react-native-view-shot';
import { config } from '@/config';
import { useSession } from '@/lib/auth/session';
import {
  buildBugReport,
  decodeBase64,
  gameIdFromPath,
  screenshotObjectPath,
  toBugReportSummaries,
  type BugReportSummary,
} from '@/lib/bug-report-model';
import { launchKeys, type LaunchPlan } from '@/lib/launch';
import { logBuffer } from '@/lib/log-buffer';
import { supabase } from '@/lib/supabase';

/**
 * "Shake to report a bug" for playtests (docs/bug-reports.md): on in dev builds and with `EXPO_PUBLIC_BUG_REPORTS=1`
 * (`config.bugReports`), off in store builds. A shake (lib/shake.ts, wired in components/rally/bug-report-sheet.tsx)
 * captures the screen and opens the sheet; Send uploads the screenshot to the private `bug-reports` bucket and inserts a
 * `bug_reports` row with the note, the app and OS versions, the route, the game id and version when it came from a
 * game, and the last ~200 log lines (lib/log-buffer.ts). Settings → Developer → Bug reports lists your own.
 */
export const bugReportKeys = {
  mine: (uid: string | null) => ['me', uid, 'bug-reports'] as const,
};

/** What the sheet shows and sends: captured when it opens, so it describes the screen the tester shook on. */
export interface BugReportDraft {
  /** Changes with every opening (the sheet's form starts fresh). */
  id: number;
  /** `data:image/jpeg;base64,…`, or null when the capture failed (or was not possible: web). */
  screenshot: string | null;
  /** Width / height of the screenshot, for the preview's aspect ratio. */
  aspect: number;
  route: string;
  gameId: string | null;
  gameVersion: string | null;
  /** The report came from a running game: WebGL content may come out blank in the screenshot. */
  inGame: boolean;
  logLines: number;
}

// --- which sheet is open (one store, two hosts: the shell's and the play route's) --------------------------------

let draft: BugReportDraft | null = null;
let draftSeq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const bugSheet = {
  open(next: BugReportDraft) {
    draft = next;
    emit();
  },
  close() {
    if (!draft) return;
    draft = null;
    emit();
  },
  get: () => draft,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

export function useBugSheet(): BugReportDraft | null {
  return useSyncExternalStore(bugSheet.subscribe, bugSheet.get, () => null);
}

/** The game id and version for a report from `pathname` (the play screen's snapshot of its launch plan). */
function gameFor(qc: QueryClient, pathname: string): { gameId: string | null; gameVersion: string | null } {
  const gameId = gameIdFromPath(pathname);
  if (!gameId) return { gameId: null, gameVersion: null };
  const plan =
    qc.getQueryData<LaunchPlan>(launchKeys.session(gameId)) ?? qc.getQueryData<LaunchPlan>(launchKeys.plan(gameId));
  return { gameId, gameVersion: plan?.status === 'ready' ? plan.version : null };
}

/** Longest edge of the uploaded screenshot, in pixels (keeps uploads well under the bucket's 5 MB). */
const SCREENSHOT_EDGE = 1280;

/** The whole screen as a JPEG data URI (the sheet is not open yet), or null when it cannot be captured. */
async function captureScreenshot(): Promise<{ uri: string; aspect: number } | null> {
  if (Platform.OS === 'web') return null;
  const { width, height } = Dimensions.get('screen');
  if (!width || !height) return null;
  const scale = Math.min(PixelRatio.get(), SCREENSHOT_EDGE / Math.max(width, height));
  try {
    const uri = await captureScreen({
      format: 'jpg',
      quality: 0.6,
      result: 'data-uri',
      width: Math.round(width * scale),
      height: Math.round(height * scale),
    });
    return { uri, aspect: width / height };
  } catch {
    return null;
  }
}

/** Capture the screen and open the sheet for `pathname`. */
export async function startBugReport(qc: QueryClient, pathname: string): Promise<void> {
  if (bugSheet.get()) return;
  const shot = await captureScreenshot();
  const game = gameFor(qc, pathname);
  const { width, height } = Dimensions.get('window');
  draftSeq += 1;
  bugSheet.open({
    id: draftSeq,
    screenshot: shot?.uri ?? null,
    aspect: shot?.aspect ?? (width && height ? width / height : 9 / 19.5),
    route: pathname,
    ...game,
    inGame: !!game.gameId,
    logLines: logBuffer.size,
  });
}

/** "iOS 18.1", "Android 15". */
export function osLabel(): string {
  const name = Platform.OS === 'ios' ? 'iOS' : Platform.OS === 'android' ? 'Android' : Platform.OS;
  return `${name} ${String(Platform.Version)}`;
}

/** Uploads the screenshot (when asked) and inserts the report. Throws on failure; a failed upload alone does not. */
export async function sendBugReport(
  userId: string,
  d: BugReportDraft,
  opts: { note: string; includeScreenshot: boolean },
): Promise<{ screenshotSent: boolean }> {
  let screenshotPath: string | null = null;
  let screenshotError: string | null = null;
  if (opts.includeScreenshot && d.screenshot) {
    const path = screenshotObjectPath(userId, Crypto.randomUUID());
    try {
      const { error } = await supabase.storage
        .from(BUG_REPORTS_BUCKET)
        .upload(path, decodeBase64(d.screenshot), { contentType: 'image/jpeg', upsert: false });
      if (error) throw error;
      screenshotPath = path;
    } catch (err) {
      screenshotError = err instanceof Error ? err.message.slice(0, 200) : 'upload failed';
    }
  }
  const { width, height } = Dimensions.get('window');
  const row = buildBugReport({
    note: opts.note,
    appVersion: config.appVersion,
    platform: Platform.OS,
    osVersion: String(Platform.Version),
    route: d.route,
    gameId: d.gameId,
    gameVersion: d.gameVersion,
    logs: logBuffer.lines(),
    screenshotPath,
    context: {
      executionEnvironment: Constants.executionEnvironment ?? null,
      expoSdk: Constants.expoConfig?.sdkVersion ?? null,
      device: Constants.deviceName ?? null,
      window: `${Math.round(width)}x${Math.round(height)}@${PixelRatio.get()}`,
      screenshot: !opts.includeScreenshot
        ? 'left out'
        : !d.screenshot
          ? 'capture failed'
          : screenshotError
            ? 'upload failed'
            : 'attached',
      // Game screens are WebGL in a WebView, which screen captures often draw blank (black) on Android and sometimes iOS.
      screenshotNote: d.inGame && screenshotPath ? 'taken over a WebGL game: the game area may be blank' : null,
      screenshotError,
    },
  });
  const { error } = await supabase.from('bug_reports').insert(row);
  if (error) throw error;
  return { screenshotSent: !!screenshotPath };
}

/** Your own recent reports, newest first (Settings → Developer → Bug reports). */
export function useMyBugReports(enabled = true) {
  const { userId } = useSession();
  return useQuery({
    queryKey: bugReportKeys.mine(userId),
    enabled: enabled && !!userId,
    queryFn: async (): Promise<BugReportSummary[]> => {
      const { data, error } = await supabase
        .from('bug_reports')
        .select('id, created_at, note, route, game_id, game_version, platform, app_version, screenshot_path')
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return toBugReportSummaries(data);
    },
  });
}
