import { type Application, Color, Entity, StandardMaterial, Vec3 } from 'playcanvas';
import { PLANE_HH, PLANE_HW, ROOM_H, type FoldSim, type Room, type SimEvent } from './sim.ts';

/**
 * PLACEHOLDER renderer (plain boxes) so the game runs end to end; the real scene replaces it behind the same
 * interface.
 */
export interface FoldScene {
  /** A new run: forget the old rooms and effects. */
  reset(sim: FoldSim): void;
  /** Per frame: interpolate the plane (sim.alpha), build / drop room meshes as sim.rooms changes, follow with the
   *  camera. `dt` is game time (0 while paused). */
  sync(sim: FoldSim, dt: number): void;
  /** Effects for a sim event (refold, flap, stamp, skid, crash …). */
  event(e: SimEvent, sim: FoldSim): void;
  /** World (x, y, z) to CSS px on the canvas. */
  project(x: number, y: number, z: number, out: { x: number; y: number }): void;
  /** Drop non-essential work (lowMemory). */
  trim(): void;
  readonly entityCount: number;
}

const COLORS: Record<string, string> = {
  doorway: '#b07a4d',
  shelf: '#7d4f33',
  lamp: '#e8c35a',
  table: '#8c5a36',
  kettle: '#c94f3d',
  radiator: '#d9dee8',
  fan: '#5a4433',
};

function mat(hex: string): StandardMaterial {
  const m = new StandardMaterial();
  const n = parseInt(hex.slice(1), 16);
  m.diffuse = new Color(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  m.update();
  return m;
}

export function createFoldScene(app: Application, _opts: { shadows?: boolean } = {}): FoldScene {
  app.scene.ambientLight = new Color(0.55, 0.55, 0.6);
  const camera = new Entity('camera');
  camera.addComponent('camera', { clearColor: new Color(0.95, 0.9, 0.8), fov: 40 });
  app.root.addChild(camera);
  const sun = new Entity('sun');
  sun.addComponent('light', { type: 'directional', intensity: 1 });
  sun.setEulerAngles(50, 30, 0);
  app.root.addChild(sun);
  const world = new Entity('world');
  app.root.addChild(world);
  const mats = new Map<string, StandardMaterial>();
  const m = (hex: string) => {
    let x = mats.get(hex);
    if (!x) mats.set(hex, (x = mat(hex)));
    return x;
  };
  const box = (parent: Entity, x0: number, x1: number, y0: number, y1: number, z: number, d: number, hex: string) => {
    const e = new Entity();
    e.addComponent('render', { type: 'box', material: m(hex) });
    e.setLocalPosition((x0 + x1) / 2, (y0 + y1) / 2, z);
    e.setLocalScale(Math.max(0.01, x1 - x0), Math.max(0.01, y1 - y0), d);
    parent.addChild(e);
    return e;
  };
  const rooms = new Map<number, Entity>();
  const buildRoom = (room: Room) => {
    const root = new Entity(`room-${room.index}`);
    world.addChild(root);
    box(root, room.x0, room.x1, -0.3, 0, 0, 4, '#9b6b44');
    box(root, room.x0, room.x1, ROOM_H, ROOM_H + 0.3, 0, 4, '#efe4cf');
    box(root, room.x0, room.x1, 0, ROOM_H, -2.1, 0.2, room.index % 2 ? '#f5e7cc' : '#e9d3ad');
    for (const pt of room.pits) box(root, pt.x0, pt.x1, -0.31, 0.01, 0, 4.02, '#2a1d17');
    for (const o of room.obstacles) box(root, o.x0, o.x1, o.y0, o.y1, 0, 1.2, COLORS[o.kind] ?? '#888888');
    for (const s of room.stamps)
      if (!s.taken) box(root, s.x - 0.15, s.x + 0.15, s.y - 0.18, s.y + 0.18, 0, 0.05, '#e5533d');
    rooms.set(room.index, root);
  };
  const plane = new Entity('plane');
  plane.addComponent('render', { type: 'box', material: m('#ffffff') });
  plane.setLocalScale(PLANE_HW * 2, PLANE_HH * 2, 0.5);
  world.addChild(plane);
  const tmp = new Vec3();

  const scene: FoldScene = {
    get entityCount() {
      return rooms.size * 20 + 10;
    },
    reset(sim) {
      for (const e of rooms.values()) e.destroy();
      rooms.clear();
      scene.sync(sim, 0);
    },
    sync(sim) {
      const seen = new Set<number>();
      for (const room of sim.rooms) {
        seen.add(room.index);
        if (!rooms.has(room.index)) buildRoom(room);
      }
      for (const [i, e] of rooms) {
        if (!seen.has(i)) {
          e.destroy();
          rooms.delete(i);
        }
      }
      const p = sim.plane,
        a = sim.alpha;
      const x = p.px + (p.x - p.px) * a,
        y = p.py + (p.y - p.py) * a;
      plane.setLocalPosition(x, y, 0);
      camera.setPosition(x + 3, ROOM_H / 2, 14);
      camera.lookAt(x + 3, ROOM_H / 2, 0);
    },
    event(e, sim) {
      // Stamps: rebuild the room so taken stamps disappear.
      if (e.type === 'stamp') {
        const room = sim.roomAt(e.x);
        if (room) {
          rooms.get(room.index)?.destroy();
          rooms.delete(room.index);
          buildRoom(room);
        }
      }
    },
    project(x, y, z, out) {
      const s = camera.camera!.worldToScreen(tmp.set(x, y, z));
      out.x = s.x;
      out.y = s.y;
    },
    trim() {},
  };
  return scene;
}
