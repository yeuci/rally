import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOOT_LABEL_MAX, createBootProgress, formatBytes, matchmakingLabel, type BootHost } from '../src/boot.ts';

const STAGES = [
  { id: 'start', label: 'Starting the game', weight: 1 },
  { id: 'models', label: 'Downloading characters', weight: 6 },
  { id: 'arena', label: 'Building the arena', weight: 1 },
  { id: 'match', label: 'Finding players', weight: 1 },
  { id: 'join', label: 'Joining the match', weight: 1 },
] as const;

function fakeHost(hosted = true) {
  const sent: { progress: number; label?: string }[] = [];
  const host: BootHost = {
    isHosted: hosted,
    ui: {
      loading: async (progress: number, label?: string) => {
        sent.push({ progress, label });
        return null;
      },
    },
  };
  return { host, sent };
}

function fakeVeil() {
  const el = () => ({ hidden: false, textContent: '', style: { width: '' } });
  const v = { root: el(), bar: el(), label: el(), detail: el() };
  return { veil: v as unknown as { root: HTMLElement; bar: HTMLElement; label: HTMLElement; detail: HTMLElement }, v };
}

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test('stages are weighted; the host gets each new label at once and 1 only from done()', () => {
  const { host, sent } = fakeHost();
  const c = clock();
  const boot = createBootProgress({ stages: STAGES, host, now: c.now, hostIntervalMs: 100 });
  assert.deepEqual(sent, [{ progress: 0, label: 'Starting the game' }], 'labelled from the very start');
  boot.stage('models');
  assert.deepEqual(sent.at(-1), { progress: 0.1, label: 'Downloading characters' });
  boot.progress(1);
  boot.stage('arena');
  boot.stage('match', 'Creating your room');
  boot.stage('join');
  boot.progress(1);
  assert.equal(boot.value, 0.99, 'the last stage at its end is still not playable');
  assert.ok(sent.every((s) => s.progress < 1));
  assert.deepEqual(
    sent.map((s) => s.label),
    ['Starting the game', 'Downloading characters', 'Building the arena', 'Creating your room', 'Joining the match'],
  );
  boot.done();
  assert.deepEqual(sent.at(-1), { progress: 1, label: 'Joining the match' });
  assert.equal(boot.value, 1);
  boot.done();
  boot.progress(0.5);
  boot.stage('models');
  assert.equal(sent.filter((s) => s.progress === 1).length, 1, 'done() is idempotent; later calls are ignored');
});

test('bar-only updates are throttled; the latest value is sent when the interval is over', async () => {
  const { host, sent } = fakeHost();
  const c = clock();
  const boot = createBootProgress({ stages: STAGES, host, now: c.now, hostIntervalMs: 20 });
  boot.stage('models');
  const before = sent.length;
  for (let i = 1; i <= 50; i++) boot.progress(i / 50);
  assert.equal(sent.length, before, 'nothing more within the interval');
  c.advance(25);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(sent.length, before + 1);
  assert.equal(sent.at(-1)!.progress, 0.7);
  assert.equal(sent.at(-1)!.label, 'Downloading characters');
});

test('the bar never moves back; progress past a stage is clamped to it', () => {
  const boot = createBootProgress({ stages: STAGES });
  boot.stage('models');
  boot.progress(0.5);
  const mid = boot.value;
  boot.progress(0.2);
  assert.equal(boot.value, mid);
  boot.stage('start'); // going back to an earlier stage changes the words, never the bar
  assert.equal(boot.value, mid);
  boot.stage('models');
  boot.progress(7);
  assert.equal(boot.value, 0.7);
  assert.throws(() => boot.stage('nope' as never), /unknown stage/);
});

test('the veil shows the same words, bytes or a percentage, and hides on done()', () => {
  const { veil, v } = fakeVeil();
  const boot = createBootProgress({ stages: STAGES, veil });
  assert.equal(v.label.textContent, 'Starting the game');
  assert.equal(v.detail.textContent, '0%');
  boot.stage('models');
  boot.progress(0.5, { loaded: 1_200_000, total: 3_400_000 });
  assert.equal(v.label.textContent, 'Downloading characters');
  assert.equal(v.detail.textContent, '1.2 of 3.4 MB');
  assert.equal(v.bar.style.width, '40%');
  boot.progress(0.6, { loaded: 900, total: null });
  assert.equal(v.detail.textContent, '46%', 'no total yet: the percentage');
  boot.stage('join');
  assert.equal(v.label.textContent, 'Joining the match');
  assert.equal(v.root.hidden, false);
  boot.done();
  assert.equal(v.root.hidden, true);
  assert.equal(v.bar.style.width, '100%');
});

test('standalone (not hosted): only the veil, no host calls', () => {
  const { host, sent } = fakeHost(false);
  const { veil, v } = fakeVeil();
  const boot = createBootProgress({ stages: STAGES, host, veil });
  boot.stage('arena');
  boot.done();
  assert.deepEqual(sent, []);
  assert.equal(v.root.hidden, true);
});

test('labels are trimmed and kept within what the host accepts', () => {
  const { host, sent } = fakeHost();
  const boot = createBootProgress({ stages: [{ id: 'a', label: `  ${'Downloading '.repeat(8)} `, weight: 1 }], host });
  assert.ok(sent[0]!.label!.length <= BOOT_LABEL_MAX);
  assert.ok(sent[0]!.label!.endsWith('…'));
  assert.equal(boot.label, sent[0]!.label);
  assert.throws(() => createBootProgress({ stages: [] }), /no stages/);
});

test('matchmaking words follow the launch context', () => {
  assert.equal(matchmakingLabel({ intent: 'quick' }), 'Finding players');
  assert.equal(matchmakingLabel({ intent: 'private' }), 'Creating your room');
  assert.equal(matchmakingLabel({ intent: 'joinById' }), 'Finding the room');
  assert.equal(matchmakingLabel({ intent: 'party' }), 'Finding your party');
  assert.equal(matchmakingLabel({ intent: 'quick', resume: { reconnectionToken: 'r:t' } }), 'Rejoining your match');
  assert.equal(matchmakingLabel(null), 'Finding players');
});

test('byte counts read like a download dialog', () => {
  assert.equal(formatBytes(1_200_000, 3_400_000), '1.2 of 3.4 MB');
  assert.equal(formatBytes(820_000, 3_400_000), '820 KB of 3.4 MB');
  assert.equal(formatBytes(0, 640_000), '0 of 640 KB');
});
