import { useQueryClient } from '@tanstack/react-query';
import { Redirect, Stack, usePathname } from 'expo-router';
import { BugIcon, CircleAlertIcon, ImageIcon } from 'lucide-react-native';
import { useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { EmptyState, RetryButton } from '@/components/rally/empty-state';
import { SectionHeader } from '@/components/rally/section-header';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { config } from '@/config';
import { startBugReport, useMyBugReports } from '@/lib/bug-report';
import { bugReportMeta, bugReportTitle, type BugReportSummary } from '@/lib/bug-report-model';
import { timeAgo } from '@/lib/format';
import { useColumnPadding, useLayout } from '@/lib/use-layout';
import { usePalette } from '@/lib/use-palette';

/**
 * Settings → Developer → Bug reports (`/bug-reports`, dev builds and `EXPO_PUBLIC_BUG_REPORTS=1` only): your own recent
 * reports, newest first (`bug_reports`, select-own RLS), and "Report a bug" for when shaking is not handy (a simulator).
 * Everyone's reports are read with the service role (docs/bug-reports.md).
 */
export default function BugReportsScreen() {
  if (!config.bugReports) return <Redirect href="/settings" />;
  return <BugReports />;
}

function BugReports() {
  const { insets } = useLayout();
  const column = useColumnPadding();
  const palette = usePalette();
  const qc = useQueryClient();
  const pathname = usePathname();
  const reports = useMyBugReports();
  const [refreshing, setRefreshing] = useState(false);

  async function refresh() {
    setRefreshing(true);
    try {
      await reports.refetch();
    } finally {
      setRefreshing(false);
    }
  }

  const report = (
    <Button variant="secondary" onPress={() => void startBugReport(qc, pathname)}>
      <Icon as={BugIcon} className="text-secondary-foreground size-4" />
      <Text>Report a bug</Text>
    </Button>
  );

  return (
    <ScrollView
      className="bg-background flex-1"
      contentContainerClassName="gap-6 pt-6"
      contentContainerStyle={[column, { paddingBottom: insets.bottom + 32 }]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          tintColor={palette.foreground}
          colors={[palette.foreground]}
          progressBackgroundColor={palette.card}
        />
      }
    >
      <Stack.Screen options={{ title: 'Bug reports' }} />
      {reports.isLoading ? (
        <BugReportListSkeleton />
      ) : reports.isError ? (
        <EmptyState
          icon={CircleAlertIcon}
          title="Couldn't load your reports"
          body="Check your connection and try again."
          action={<RetryButton onPress={() => void reports.refetch()} />}
        />
      ) : !reports.data || reports.data.length === 0 ? (
        <EmptyState
          icon={BugIcon}
          title="No reports yet"
          body="Shake your phone on any screen to send one."
          action={report}
        />
      ) : (
        <>
          <View className="gap-3">
            <SectionHeader title="Your reports" detail={String(reports.data.length)} className="px-0" />
            <BugReportList reports={reports.data} />
          </View>
          <View className="items-center">{report}</View>
        </>
      )}
    </ScrollView>
  );
}

function BugReportList({ reports }: { reports: BugReportSummary[] }) {
  return (
    <View className="bg-card border-border overflow-hidden rounded-2xl border">
      {reports.map((r, i) => (
        <View key={r.id}>
          {i > 0 && <Separator className="ml-4" />}
          <View
            className="gap-1 px-4 py-3"
            accessible
            accessibilityLabel={`${bugReportTitle(r)}, ${timeAgo(r.createdAt)}, ${bugReportMeta(r)}`}
          >
            <View className="flex-row items-baseline gap-3">
              <Text className="shrink grow text-[15px] font-semibold leading-5" numberOfLines={2}>
                {bugReportTitle(r)}
              </Text>
              <Text variant="muted" className="text-[13px]">
                {timeAgo(r.createdAt)}
              </Text>
            </View>
            <View className="flex-row items-center gap-1.5">
              {r.hasScreenshot ? <Icon as={ImageIcon} className="text-muted-foreground size-3.5" /> : null}
              <Text variant="muted" className="shrink text-[13px] leading-[18px]" numberOfLines={1}>
                {bugReportMeta({ ...r, hasScreenshot: false })}
              </Text>
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}

function BugReportListSkeleton() {
  return (
    <View className="gap-3">
      <SkeletonText lineHeight={22} width={120} />
      <View className="bg-card border-border overflow-hidden rounded-2xl border">
        {[0, 1, 2].map((i) => (
          <View key={i} className="gap-1 px-4 py-3">
            {i > 0 && <Separator className="-mt-3 mb-3" />}
            <SkeletonText lineHeight={20} width={i % 2 ? '50%' : '70%'} />
            <Skeleton className="h-3 w-40 rounded" />
          </View>
        ))}
      </View>
    </View>
  );
}
