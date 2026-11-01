import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BotCrew, DT, SushiGame, WEEK_DAYS, type DaySummary } from '../src/index.ts';

/**
 * The headless simulation: crews of helper bots (server/src/bots.ts: the same inputs a player sends) play the week
 * with the real tuning, voting the upgrades a sensible crew would. Bots plan worse than a good crew and better than a
 * distracted one; the point is a sanity check of the numbers at every crew size, not a perfect score:
 * - every crew size reaches Sunday on every seed (Monday to Saturday are survivable),
 * - every crew size survives the whole week on at least one seed (Sunday's festival is beatable),
 * - and the work is real: a kitchen where nobody cooks loses most of its stars on Monday.
 */
function week(crew: number, seed: number): DaySummary[] {
  const g = new SushiGame({ seed, rules: { voteTime: 1, morningTime: 2 } });
  const bots = new BotCrew(g);
  for (let i = 0; i < crew; i++) g.addPlayer(`bot:${i}`, `Bot ${i + 1}`, true);
  g.skipToDay(1);
  const days: DaySummary[] = [];
  for (let t = 0; t < 7 * 220; t += DT) {
    bots.think(DT);
    for (const e of g.step(DT)) if (e.type === 'dayOver' || e.type === 'runOver') days.push(e.summary);
    if (g.phase === 'over' || g.day > WEEK_DAYS) break;
  }
  return days;
}

const SEEDS = [11, 12, 13];

for (let crew = 1; crew <= 4; crew++) {
  test(`a crew of ${crew}: reaches Sunday every time, survives the week at least once`, () => {
    const runs = SEEDS.map((seed) => week(crew, seed));
    const lines = runs.map(
      (r, i) =>
        `seed ${SEEDS[i]}: ` +
        r.map((d) => `${d.day}:${d.served}/${d.angry}${d.closed ? 'x' : ''}★${d.stars}`).join(' '),
    );
    for (const [i, r] of runs.entries()) {
      assert.ok(r.length >= WEEK_DAYS && r[WEEK_DAYS - 1]!.day === WEEK_DAYS, `reached Sunday\n${lines[i]}`);
      for (const d of r.slice(0, WEEK_DAYS - 1)) assert.ok(!d.closed, `closed before Sunday\n${lines[i]}`);
      // Every day sees real business.
      for (const d of r) assert.ok(d.served >= 3, `served on day ${d.day}\n${lines[i]}`);
    }
    assert.ok(
      runs.some((r) => r[WEEK_DAYS - 1]!.week),
      `nobody survived Sunday:\n${lines.join('\n')}`,
    );
  });
}

test('a kitchen where nobody cooks loses most of its stars on Monday', () => {
  const g = new SushiGame({ seed: 5, rules: { morningTime: 1 } });
  g.addPlayer('a', 'Idle');
  g.skipToDay(1);
  let summary: DaySummary | null = null;
  for (let t = 0; t < 250 && !summary; t += DT) {
    for (const e of g.step(DT)) if (e.type === 'dayOver' || e.type === 'runOver') summary = e.summary;
  }
  assert.ok(summary);
  assert.ok(summary.angry >= 3, `angry ${summary.angry}`);
  assert.equal(summary.served, 0);
});
