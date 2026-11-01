/**
 * @rally/model-pipeline: the shared, node-only half of the games' models (the runtime half is game-kit's models.ts).
 * A game's `scripts/models.ts` pins its packs (`loadPack`: the art-source release or `MODELS_SRC`, sha256-checked),
 * picks the models and turns them into small gzipped GLBs:
 * - `character()`: a rigged character as one skinned, vertex-coloured mesh (bone-parented parts merged in), welded,
 *   simplified and split flat; `attachment()`: a mesh rigged to a bone (a gun in the hand) with its bone transform,
 *   `farthestVertex()`: a point on it in a pose (its muzzle);
 *   `clipsOnly()` / `reduceKeys()` / `completeClips()`: one shared clip file (the whole body's clips completed with
 *   rest channels, so no bone keeps another clip's pose); `boneFrames()` + `halfFloats()`: clips baked into bone
 *   matrices for instanced crowds;
 * - `staticModel()` / `objSoup()`: props from glTF or OBJ (textured parts kept apart), `modelPack()`: many in one GLB;
 * - `Emitter`: gzipped files and a generated meta module. games/gunrun/scripts/models.ts is a complete example.
 */
export {
  ART_SOURCE_RELEASE,
  entry,
  loadPack,
  sha256,
  text,
  type Pack,
  type PackOptions,
  type PackSpec,
} from './source.ts';
export { compose, decompose, identity, invertAffine, mirrors, mul, transformPoint, type Mat4 } from './math.ts';
export {
  addSoup,
  byte,
  concatSoups,
  emptyGeometry,
  flat,
  floats,
  pruneAccessors,
  pruneMaterials,
  rebuild,
  replaceMesh,
  simplifierReady,
  triangleCount,
  vertexMaterial,
  type Geometry,
  type RebuildOptions,
  type Rgb,
  type Soup,
} from './soup.ts';
export {
  attachment,
  character,
  farthestVertex,
  localMatrix,
  parents,
  readGltf,
  staticModel,
  worldMatrix,
  type Attachment,
  type Character,
  type CharacterOptions,
  type StaticModel,
  type StaticOptions,
} from './gltf.ts';
export { assertSameSkeleton, clipsOnly, completeClips, disposeAnimation, keepClips, reduceKeys } from './clips.ts';
export {
  boneFrames,
  fromHalf,
  halfFloats,
  poseAt,
  sampleChannel,
  toHalf,
  type BoneFrames,
  type ClipTable,
} from './bones.ts';
export { mtlColors, objSoup } from './obj.ts';
export { decodePng, encodePng, resize, type Image } from './png.ts';
export { Emitter, compactJson, kb, modelPack, type PackEntry } from './emit.ts';
