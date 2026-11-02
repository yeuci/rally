import { View } from 'react-native';

/**
 * The press highlight of a row in a list or card: a rounded surface inset from the row's edges, drawn under the row's
 * content while it is pressed (the row's first child, inside a `({ pressed }) => …` Pressable child). A full-width
 * highlight met the indented hairline between rows at a step, a jagged notch below the icon or picture; inset, it
 * never touches the hairlines or the card's rounded corners.
 */
export function RowHighlight({ pressed }: { pressed: boolean }) {
  if (!pressed) return null;
  return <View pointerEvents="none" className="bg-accent absolute inset-x-1.5 inset-y-1 rounded-xl" />;
}
