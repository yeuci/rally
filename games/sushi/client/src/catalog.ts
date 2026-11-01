import { Kind, tierOf } from '@rally/game-sushi-server';
import type { FoodName } from './models.ts';

/**
 * How each item kind looks: its food model, how big it is drawn (world units across its largest side: the pack's food
 * is shown large next to the chefs, as in the pack's preview, so a phone can tell salmon from tuna) and its plate.
 */
export const KIND_MODEL: Readonly<Partial<Record<Kind, FoodName>>> = {
  [Kind.SalmonFish]: 'SalmonFish',
  [Kind.Tuna]: 'Tuna',
  [Kind.Octopus]: 'Octopus',
  [Kind.Cucumber]: 'Cucumber',
  [Kind.SeaUrchin]: 'SeaUrchin',
  [Kind.Eel]: 'Eel',
  [Kind.Ebi]: 'Ebi',
  [Kind.Avocado]: 'Avocado',
  [Kind.Crabsticks]: 'Crabsticks',
  [Kind.Nori]: 'Nori',
  [Kind.Rice]: 'Rice',
  [Kind.GyozaRaw]: 'GyozaRaw',
  [Kind.Salmon]: 'Salmon',
  [Kind.TunaSlice]: 'TunaSlice',
  [Kind.Tentacle]: 'Tentacle',
  [Kind.SlicedCucumber]: 'SlicedCucumber',
  [Kind.SeaUrchinOpen]: 'SeaUrchinOpen',
  [Kind.EelSlice]: 'EelSlice',
  [Kind.Onigiri]: 'Onigiri',
  [Kind.SalmonNigiri]: 'SalmonNigiri',
  [Kind.MaguroNigiri]: 'MaguroNigiri',
  [Kind.OctopusNigiri]: 'OctopusNigiri',
  [Kind.EbiNigiri]: 'EbiNigiri',
  [Kind.Roll]: 'Roll',
  [Kind.SalmonRoll]: 'SalmonRoll',
  [Kind.California]: 'California',
  [Kind.SeaUrchinRoll]: 'SeaUrchinRoll',
  [Kind.UnagiNigiri]: 'UnagiNigiri',
  [Kind.Ramen]: 'Ramen',
  [Kind.Udon]: 'Udon',
  [Kind.Gyoza]: 'Gyoza',
  [Kind.Chukaman]: 'Chukaman',
  [Kind.GyozaBurnt]: 'GyozaBurnt',
  [Kind.DirtyPlate]: 'PlateDirty',
};

/** World size (largest side) by kind; the default suits a nigiri. */
export function kindSize(k: Kind): number {
  switch (k) {
    case Kind.Ramen:
    case Kind.Udon:
      return 0.62;
    case Kind.Rice:
    case Kind.Nori:
      return 0.48;
    case Kind.Octopus:
    case Kind.Eel:
    case Kind.Tuna:
    case Kind.SalmonFish:
    case Kind.Cucumber:
      return 0.62;
    case Kind.DirtyPlate:
      return 0.5;
    case Kind.Gyoza:
    case Kind.GyozaRaw:
    case Kind.GyozaBurnt:
    case Kind.Chukaman:
      return 0.34;
    default:
      return 0.46;
  }
}

/** The plate model for a belt dish (its price colour). */
export function plateOf(k: Kind): FoodName {
  const tier = tierOf(k);
  return tier === 'gold' ? 'PlateGold' : tier === 'red' ? 'PlateRed' : 'PlateWhite';
}

/** Kinds drawn as icons (order bubbles, the mat, the button). */
export const ICON_KINDS: readonly Kind[] = Object.keys(KIND_MODEL).map(Number) as Kind[];
