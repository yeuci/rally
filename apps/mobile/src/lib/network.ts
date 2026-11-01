import { useNetInfo } from '@react-native-community/netinfo';
import { useEffect, useState } from 'react';
import { OFFLINE_BANNER_DELAY_MS, isOffline } from '@/lib/network-state';

/**
 * The device's connectivity for the offline banner (components/rally/offline-banner.tsx), from
 * @react-native-community/netinfo (shipped in Expo Go). TanStack Query's onlineManager is fed from the same source in
 * lib/query-client.ts, so queries pause without a network and refetch when it comes back. Rules: lib/network-state.ts.
 */

/** True once the device has been offline for `OFFLINE_BANNER_DELAY_MS`; false again as soon as it is back. */
export function useOffline(): boolean {
  const net = useNetInfo();
  const offline = isOffline(net);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!offline) return;
    const timer = setTimeout(() => setShown(true), OFFLINE_BANNER_DELAY_MS);
    return () => {
      clearTimeout(timer);
      setShown(false);
    };
  }, [offline]);
  return offline && shown;
}
