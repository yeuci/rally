import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { launchStore, useLaunchStore } from '@/launch-store';

export default function SpikeLauncher() {
  const { settings, lastRun } = useLaunchStore();
  const insets = useSafeAreaInsets();

  return (
    <ScrollView contentContainerStyle={[styles.container, { paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
      <Text style={styles.h1}>M0 spike launcher</Text>
      <Text style={styles.p}>
        Loads the PlayCanvas spike bundle full-screen in a WebView, completes the bridge handshake, matchmakes into the Colyseus
        hello room and reports FPS, frame time, bridge RTT and socket RTT.
      </Text>

      <Text style={styles.label}>Game bundle URL</Text>
      <TextInput
        style={styles.input}
        value={settings.bundleUrl}
        onChangeText={(bundleUrl) => launchStore.setSettings({ bundleUrl })}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="https://…/games/spike/0.1.0/index.html"
        placeholderTextColor="#5b6b80"
      />

      <Text style={styles.label}>Colyseus HTTP URL</Text>
      <TextInput
        style={styles.input}
        value={settings.colyseusUrl}
        onChangeText={(colyseusUrl) => launchStore.setSettings({ colyseusUrl: colyseusUrl.replace(/\/$/, '') })}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="https://<app>.colyseus.cloud"
        placeholderTextColor="#5b6b80"
      />

      <Pressable style={styles.button} onPress={() => router.push('/game/spike')}>
        <Text style={styles.buttonText}>Launch spike</Text>
      </Pressable>

      {lastRun && (
        <View style={styles.card}>
          <Text style={styles.h2}>Last run</Text>
          <Row k="ended" v={new Date(lastRun.endedAt).toLocaleTimeString()} />
          <Row k="reason" v={lastRun.reason} />
          <Row k="ready()" v={lastRun.readyMs === null ? '—' : `${lastRun.readyMs} ms`} />
          {lastRun.error && <Row k="error" v={lastRun.error} />}
          {lastRun.metrics &&
            Object.entries(lastRun.metrics).map(([k, v]) => <Row key={k} k={k} v={String(v)} />)}
        </View>
      )}

      <Text style={styles.footnote}>
        Memory is measured from Xcode Instruments / Android Studio Profiler on the WebView content process (architecture
        §10, M0 verification).
      </Text>
    </ScrollView>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.k}>{k}</Text>
      <Text style={styles.v} selectable>
        {v}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 10, backgroundColor: '#0b1019' },
  h1: { color: '#f8fafc', fontSize: 22, fontWeight: '700' },
  h2: { color: '#f8fafc', fontSize: 16, fontWeight: '600', marginBottom: 6 },
  p: { color: '#9fb3c8', fontSize: 14, lineHeight: 20 },
  label: { color: '#9fb3c8', fontSize: 12, marginTop: 10 },
  input: {
    color: '#f8fafc',
    backgroundColor: '#121a27',
    borderColor: '#263247',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  button: { marginTop: 16, backgroundColor: '#41b6e6', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  buttonText: { color: '#0b1019', fontWeight: '700', fontSize: 16 },
  card: { marginTop: 20, backgroundColor: '#121a27', borderRadius: 12, padding: 14, gap: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  k: { color: '#9fb3c8', fontSize: 13 },
  v: { color: '#f8fafc', fontSize: 13, flexShrink: 1, textAlign: 'right' },
  footnote: { color: '#5b6b80', fontSize: 12, marginTop: 16, lineHeight: 18 },
});
