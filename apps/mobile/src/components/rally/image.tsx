import { Image as ExpoImage } from 'expo-image';
import { withUniwind } from 'uniwind';

/** expo-image with Uniwind `className` support (disk + memory cache, blurhash-ready). */
export const Image = withUniwind(ExpoImage);
