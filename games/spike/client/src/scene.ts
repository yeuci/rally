import * as pc from 'playcanvas';

export interface SceneHandle {
  app: pc.Application;
  setCubeCount(n: number): void;
  readonly cubeCount: number;
  destroy(): void;
}

/** DPR is capped at 2: higher only burns fill rate on phones (architecture §2). */
export const MAX_PIXEL_RATIO = 2;

export function createScene(canvas: HTMLCanvasElement): SceneHandle {
  const app = new pc.Application(canvas, {
    graphicsDeviceOptions: {
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    },
    mouse: new pc.Mouse(canvas),
    touch: pc.platform.touch ? new pc.TouchDevice(canvas) : undefined,
  });

  app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
  app.setCanvasResolution(pc.RESOLUTION_AUTO);
  app.graphicsDevice.maxPixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);

  const onResize = () => app.resizeCanvas();
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

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

  app.start();

  return {
    app,
    setCubeCount,
    get cubeCount() {
      return cubes.length;
    },
    destroy() {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      app.destroy();
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
