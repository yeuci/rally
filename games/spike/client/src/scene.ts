import { createApp } from '@rally/game-kit';
import * as pc from 'playcanvas';

export interface SceneHandle {
  app: pc.Application;
  setCubeCount(n: number): void;
  readonly cubeCount: number;
  destroy(): void;
}

export function createScene(canvas: HTMLCanvasElement): SceneHandle {
  // Full-window canvas, DPR capped at 2, resize/orientation handling (shared boot in @rally/game-kit).
  const boot = createApp({ canvas, pointerDevices: true });
  const { app } = boot;

  // Camera
  const camera = new pc.Entity('camera');
  camera.addComponent('camera', { clearColor: new pc.Color(0.05, 0.07, 0.1), farClip: 200 });
  camera.setPosition(0, 10, 22);
  camera.lookAt(0, 0, 0);
  app.root.addChild(camera);

  // Lights
  const sun = new pc.Entity('sun');
  sun.addComponent('light', {
    type: 'directional',
    color: new pc.Color(1, 0.97, 0.9),
    intensity: 1.4,
    castShadows: true,
    shadowBias: 0.2,
    normalOffsetBias: 0.05,
    shadowResolution: 1024,
    shadowDistance: 60,
  });
  sun.setEulerAngles(45, 30, 0);
  app.root.addChild(sun);
  app.scene.ambientLight = new pc.Color(0.25, 0.28, 0.35);

  // Ground
  const groundMat = new pc.StandardMaterial();
  groundMat.diffuse = new pc.Color(0.16, 0.2, 0.27);
  groundMat.update();
  const ground = new pc.Entity('ground');
  ground.addComponent('render', { type: 'plane', material: groundMat });
  ground.setLocalScale(60, 1, 60);
  ground.setPosition(0, -1, 0);
  app.root.addChild(ground);

  // Cubes: one material per hue bucket so there are real material switches, like a game would have.
  const materials: pc.StandardMaterial[] = [];
  for (let i = 0; i < 8; i++) {
    const m = new pc.StandardMaterial();
    const h = i / 8;
    m.diffuse = new pc.Color().fromString(hslToHex(h, 0.6, 0.55));
    m.gloss = 0.6;
    m.metalness = 0.2;
    m.useMetalness = true;
    m.update();
    materials.push(m);
  }

  const cubesRoot = new pc.Entity('cubes');
  app.root.addChild(cubesRoot);
  const cubes: { e: pc.Entity; speed: number; phase: number; radius: number; height: number }[] = [];

  function setCubeCount(n: number) {
    while (cubes.length > n) {
      const c = cubes.pop()!;
      c.e.destroy();
    }
    while (cubes.length < n) {
      const i = cubes.length;
      const e = new pc.Entity(`cube-${i}`);
      e.addComponent('render', { type: 'box', material: materials[i % materials.length], castShadows: true });
      const s = 0.4 + ((i * 7919) % 100) / 160;
      e.setLocalScale(s, s, s);
      cubesRoot.addChild(e);
      cubes.push({
        e,
        speed: 0.3 + ((i * 104729) % 100) / 100,
        phase: ((i * 15485863) % 1000) / 1000 * Math.PI * 2,
        radius: 3 + (i % 40) * 0.45,
        height: ((i * 32452843) % 100) / 100 * 6,
      });
    }
  }

  let t = 0;
  app.on('update', (dt: number) => {
    t += dt;
    for (const c of cubes) {
      const a = c.phase + t * c.speed;
      c.e.setPosition(Math.cos(a) * c.radius, c.height + Math.sin(t * 2 + c.phase) * 0.5, Math.sin(a) * c.radius);
      c.e.setEulerAngles(t * 40 * c.speed, t * 60 * c.speed, 0);
    }
    camera.setPosition(Math.sin(t * 0.15) * 24, 10 + Math.sin(t * 0.1) * 2, Math.cos(t * 0.15) * 24);
    camera.lookAt(0, 1.5, 0);
  });

  // Landmark: a tall pillar with an arrow pointing +X at the centre of the map, so camera orientation and
  // a page reload (the arrow snaps back to its start angle) are obvious at a glance.
  const landmarkMat = new pc.StandardMaterial();
  landmarkMat.diffuse = new pc.Color(1, 1, 1);
  landmarkMat.emissive = new pc.Color(0.9, 0.9, 0.9);
  landmarkMat.update();
  const pillar = new pc.Entity('landmark-pillar');
  pillar.addComponent('render', { type: 'cylinder', material: landmarkMat, castShadows: true });
  pillar.setLocalScale(0.6, 14, 0.6);
  pillar.setPosition(0, 6, 0);
  app.root.addChild(pillar);
  const arrowMat = new pc.StandardMaterial();
  arrowMat.diffuse = new pc.Color(1, 0.25, 0.2);
  arrowMat.emissive = new pc.Color(0.6, 0.1, 0.05);
  arrowMat.update();
  const arrow = new pc.Entity('landmark-arrow');
  arrow.addComponent('render', { type: 'box', material: arrowMat, castShadows: true });
  arrow.setLocalScale(6, 0.6, 1.2);
  arrow.setPosition(3.5, 13, 0);
  app.root.addChild(arrow);
  const tip = new pc.Entity('landmark-tip');
  tip.addComponent('render', { type: 'cone', material: arrowMat, castShadows: true });
  tip.setLocalScale(2.4, 2.2, 2.4);
  tip.setEulerAngles(0, 0, -90);
  tip.setPosition(7.6, 13, 0);
  app.root.addChild(tip);

  app.start();

  return {
    app,
    setCubeCount,
    get cubeCount() {
      return cubes.length;
    },
    destroy() {
      boot.destroy();
    },
  };
}

function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}
