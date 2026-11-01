import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BELT_RECIPES,
  CARDS,
  CREW_STATIONS,
  Kind,
  Rng,
  beltOrder,
  beltRecipesOn,
  botChoice,
  cardById,
  couldBecome,
  decodeItem,
  hotRecipesOn,
  item,
  itemCode,
  matItems,
  matMask,
  matchRecipe,
  offerCards,
  omakase,
  orderWeights,
  tableOrder,
  tally,
  tierOf,
  type CardId,
} from '../src/index.ts';

test('orders come only from the recipes unlocked by the day', () => {
  const rng = new Rng(3);
  for (let day = 1; day <= 9; day++) {
    const belt = new Set(beltRecipesOn(day).map((r) => r.dish));
    const hot = new Set(hotRecipesOn(day).map((r) => r.dish));
    for (let i = 0; i < 200; i++) {
      assert.ok(belt.has(beltOrder(rng, day, Math.min(1, (day - 1) / 6))), `belt order on day ${day}`);
      if (hot.size) assert.ok(hot.has(tableOrder(rng, day, 0.5)), `table order on day ${day}`);
    }
  }
  assert.deepEqual(
    beltRecipesOn(1).map((r) => r.dish),
    [Kind.Onigiri, Kind.SalmonNigiri, Kind.MaguroNigiri],
    'Monday: belt and nigiri',
  );
  assert.ok(
    beltRecipesOn(2).some((r) => r.dish === Kind.Roll),
    'Tuesday: rolls',
  );
  assert.equal(hotRecipesOn(2).length, 0);
  assert.ok(hotRecipesOn(3).length > 0, 'Wednesday: hot dishes');
  assert.equal(beltRecipesOn(9).length, BELT_RECIPES.length, 'Overtime orders everything');
});

test('the mix leans toward effortful recipes later in the week, and the new dish is practised the day it opens', () => {
  const recipes = beltRecipesOn(7);
  const early = orderWeights(recipes, 8, 0);
  const late = orderWeights(recipes, 8, 1);
  const california = recipes.findIndex((r) => r.dish === Kind.California);
  const onigiri = recipes.findIndex((r) => r.dish === Kind.Onigiri);
  assert.equal(early[california], early[onigiri], 'no lean at complexity 0');
  assert.ok(late[california]! > late[onigiri]!, 'the four-ingredient roll is ordered more at complexity 1');
  const tuesday = orderWeights(beltRecipesOn(2), 2, 0);
  const roll = beltRecipesOn(2).findIndex((r) => r.dish === Kind.Roll);
  assert.ok(tuesday[roll]! > tuesday[0]!, 'Tuesday favours its new rolls');
  // Statistically: Sunday orders more red and gold than Monday could.
  const rng = new Rng(9);
  let fancy = 0;
  for (let i = 0; i < 1000; i++) if (tierOf(beltOrder(rng, 7, 1)) !== 'white') fancy++;
  assert.ok(fancy > 350, `Sunday's plates: ${fancy}/1000 red or gold`);
});

test('the VIP omakase: three different belt dishes, red and gold favoured', () => {
  const rng = new Rng(5);
  let gold = 0;
  for (let i = 0; i < 300; i++) {
    const o = omakase(rng, 6);
    assert.equal(o.length, 3);
    assert.equal(new Set(o).size, 3);
    for (const k of o) assert.ok(beltRecipesOn(6).some((r) => r.dish === k));
    gold += o.filter((k) => tierOf(k) === 'gold').length;
  }
  assert.ok(gold > 300 * 0.5, 'gold plates appear in most omakase menus');
});

test('the mat: recipes match exactly (any order), partial sets that could still become one are accepted', () => {
  assert.equal(matchRecipe([Kind.Salmon, Kind.Rice], 1)?.dish, Kind.SalmonNigiri);
  assert.equal(matchRecipe([Kind.Nori, Kind.Rice, Kind.Salmon], 1), null, 'salmon roll is Tuesday');
  assert.equal(matchRecipe([Kind.Nori, Kind.Rice, Kind.Salmon], 2)?.dish, Kind.SalmonRoll);
  assert.equal(matchRecipe([Kind.Rice, Kind.Nori, Kind.Crabsticks, Kind.Avocado], 4)?.dish, Kind.California);
  assert.equal(matchRecipe([Kind.Rice, Kind.Rice], 7), null, 'duplicates never match');
  assert.ok(couldBecome([Kind.Rice], 1));
  assert.ok(couldBecome([Kind.Nori, Kind.Crabsticks], 4));
  assert.ok(!couldBecome([Kind.Nori, Kind.Crabsticks], 3), 'no California before Thursday');
  assert.ok(!couldBecome([Kind.Salmon, Kind.TunaSlice], 7), 'no recipe has both');
});

test('items and mats pack into the state and back', () => {
  for (const it of [item(Kind.SalmonNigiri, true), item(Kind.DirtyPlate, false, 6), item(Kind.Rice)]) {
    assert.deepEqual(decodeItem(itemCode(it)), it);
  }
  assert.equal(itemCode(null), 0);
  assert.equal(decodeItem(0), null);
  assert.ok(itemCode(item(Kind.DeliveryBox, true, 15)) < 65536);
  const mat = [Kind.Rice, Kind.Nori, Kind.Avocado];
  assert.deepEqual(new Set(matItems(matMask(mat))), new Set(mat));
});

test('the night offers three different cards, never useless ones, at most two double-edged', () => {
  const rng = new Rng(17);
  const owned = new Map<CardId, number>([['knives', 1]]);
  for (let i = 0; i < 300; i++) {
    const day = 1 + (i % 9);
    const crew = 1 + (i % 4);
    const cards = offerCards(rng, day, owned, crew);
    assert.equal(cards.length, 3);
    assert.equal(new Set(cards).size, 3);
    assert.ok(!cards.includes('knives'), 'owned, not stackable');
    assert.ok(cards.filter((c) => cardById(c)?.edge).length <= 2, 'a plain upgrade is always there');
    for (const c of cards) assert.ok((cardById(c)!.from ?? 0) <= day, `${c} only once it matters`);
    if (crew <= 1) assert.ok(!cards.includes('cooker'), 'solo crews have the cooker already');
    if (crew >= CREW_STATIONS) assert.ok(!cards.includes('board2') && !cards.includes('mat2'));
  }
  assert.ok(!offerCards(rng, 5, new Map([['expand', 2]]), 2).includes('expand'), 'expand stops at two');
  assert.ok(CARDS.some((c) => c.edge) && CARDS.some((c) => !c.edge));
});

test('votes: the majority wins; a tie (or nobody voting) is broken at random among the tied', () => {
  const rng = new Rng(1);
  const cards: CardId[] = ['knives', 'belt', 'critic'];
  assert.equal(tally(rng, cards, [1, 1, 0]), 1);
  assert.equal(tally(rng, cards, [2, -1, -1]), 2);
  const picks = new Set<number>();
  for (let i = 0; i < 60; i++) picks.add(tally(rng, cards, [0, 2]));
  assert.deepEqual([...picks].sort(), [0, 2], 'only the tied cards win a tie');
  const any = new Set<number>();
  for (let i = 0; i < 60; i++) any.add(tally(rng, cards, []));
  assert.equal(any.size, 3, 'no votes: any card');
  assert.equal(botChoice(['critic', 'mat2', 'belt']), 1, 'bots prefer the second mat');
});
