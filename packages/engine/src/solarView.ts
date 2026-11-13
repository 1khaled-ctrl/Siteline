import { KM_PER_AU, PLANET_NAMES, type PlanetName, type SolarBodyKey, type Vec3 } from '@siteline/physics';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { angleBetween, reportFlight, zoomSize } from './flights';
import { fitCamera, type Insets, LookOffset, NO_INSETS, type ScreenPoint, toScreen } from './screen';

/** Everything the overview draws; the Sun is fixed at the origin. */
export type SolarLabelKey = SolarBodyKey | 'sun';

/**
 * Which name stays when two labels would overlap: the Sun and the worlds you can fly into first, then the giants, and
 * the small inner planets last, so a crowded middle of the system keeps the names that matter.
 */
const LABEL_RANK: readonly SolarLabelKey[] = [
  'sun',
  'earth',
  'moon',
  'mars',
  'jupiter',
  'saturn',
  'venus',
  'uranus',
  'neptune',
  'mercury',
];

export interface SolarSnapshot {
  /** Planet positions from the Sun and the Moon's from the Earth, in km, ECLIPJ2000. */
  positionsKm: Record<SolarBodyKey, Vec3>;
}

export interface SolarViewOptions {
  labels: Record<SolarLabelKey, string>;
  /** Bodies that can be flown into; the rest are labelled but not clickable. */
  navigable: ReadonlySet<SolarBodyKey>;
  /** Colour maps for the bodies that have one; the rest stay a flat colour. */
  textures?: Partial<Record<SolarBodyKey, string>>;
  onSelect?: (body: SolarBodyKey) => void;
  /** A click on a body that has no view to fly into. */
  onPoint?: (body: SolarBodyKey) => void;
  /** The pointer coming onto a body or its name, or leaving it (null). */
  onHover?: (body: SolarBodyKey | null) => void;
  /**
   * For the app's opening: hold the camera straight over the Sun, close enough that the Earth's orbit is this many
   * pixels in radius, until `setIntroProgress` pulls it back. Without it the view opens with its own short dolly.
   */
  introRingPx?: number;
  /**
   * Coming back from this world's own view: the view opens close beside the world and pulls back out to the whole
   * system once the planets are placed, instead of its usual short dolly. A cut with reduced motion.
   */
  arriveFrom?: SolarBodyKey;
  /** The pull back from `arriveFrom` is over and the view is the usual one. */
  onArrive?: () => void;
}

// Sizes are for looking at, not to scale: the real Sun is 109 Earths wide.
export const LOOK: Record<SolarLabelKey, { size: number; color: number }> = {
  sun: { size: 2.4, color: 0xffd27a },
  mercury: { size: 0.42, color: 0xa8a39c },
  venus: { size: 0.62, color: 0xe6c98a },
  earth: { size: 0.68, color: 0x3b7fd1 },
  moon: { size: 0.2, color: 0xcfcfcf },
  mars: { size: 0.54, color: 0xc9623b },
  jupiter: { size: 1.75, color: 0xd8b58a },
  saturn: { size: 1.5, color: 0xe3d2a0 },
  uranus: { size: 1, color: 0x8fd3dc },
  neptune: { size: 0.98, color: 0x4d6fe0 },
};
/** Visual spin in radians per second: slow enough to watch, nowhere near the real rates. */
const SPIN: Partial<Record<SolarLabelKey, number>> = {
  mercury: 0.02,
  venus: 0.015,
  earth: 0.05,
  moon: 0.012,
  mars: 0.045,
  jupiter: 0.09,
  saturn: 0.075,
  uranus: 0.04,
  neptune: 0.04,
};
/** Axial tilt in radians, so the spin reads at a glance (Uranus rolls on its side). */
const TILT: Partial<Record<SolarLabelKey, number>> = { earth: 0.41, mars: 0.44, saturn: 0.47, uranus: 1.71 };
const MOON_ORBIT_SCENE = 1.25;
const ORBIT_COLOR = 0x3a4656;
/** How much of each orbit glows behind the planet, as a comet-tail trail. */
const TRAIL_FRACTION = 0.45;
const IDLE_DRIFT_AFTER_MS = 12_000;
/** The pull back out from a world: how long, how close it starts (in the world's radii), and the longest wait for its map. */
const PULL_BACK_MS = 2600;
const PULL_BACK_FROM_RADII = 3.5;
const PULL_BACK_WAIT_MS = 600;
/** How far round toward the Sun the pull back starts from the usual angle, so the world shows its day side. */
const PULL_BACK_SUNWARD = 0.7;

/** Square-root radial scale: Mercury (0.39 AU) and Neptune (30 AU) both fit on screen. */
const radial = (au: number) => 14 * Math.sqrt(au);

// Ecliptic plane is scene XZ with north up: scene = (x, z, −y).
function toScene(km: Vec3, out = new THREE.Vector3()): THREE.Vector3 {
  const r = Math.hypot(km[0], km[1], km[2]);
  if (r === 0) return out.set(0, 0, 0);
  const k = radial(r / KM_PER_AU) / r;
  return out.set(km[0] * k, km[2] * k, -km[1] * k);
}

const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);

/** How wide the overview keeps its colour maps: its worlds are small on screen, so a larger map costs only memory and time. */
const MAP_PX = 2048;

/**
 * A colour map at `MAP_PX` wide, decoded and scaled from the file's bytes off the main thread where the browser can.
 * The Mars view's map is 8192 px wide: here it would take about 170 MB of GPU memory, and decoding it on the main thread
 * stalls the picture for a moment each time the overview opens.
 */
async function loadMap(url: string): Promise<THREE.Texture> {
  let source: HTMLCanvasElement | HTMLImageElement;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} for ${url}`);
    const bitmap = await createImageBitmap(await response.blob(), { resizeWidth: MAP_PX, resizeQuality: 'high' });
    // Copied to a canvas, so it uploads the usual way up (a bitmap would need flipping as it is made, which not every
    // browser does).
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('no 2D canvas');
    g.drawImage(bitmap, 0, 0);
    bitmap.close();
    source = canvas;
  } catch {
    // Without that (an older browser), the image as it is, decoded off the main thread at least.
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = url;
    await img.decode();
    source = img;
  }
  const map = new THREE.Texture(source);
  map.needsUpdate = true;
  return map;
}

/** A soft white disc that fades out to its edge; each sprite's colour tints it. */
function glowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const g = canvas.getContext('2d');
  if (g) {
    const fade = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    fade.addColorStop(0, 'rgba(255,255,255,1)');
    fade.addColorStop(0.2, 'rgba(255,255,255,0.45)');
    fade.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = fade;
    g.fillRect(0, 0, 128, 128);
  }
  return new THREE.CanvasTexture(canvas);
}

/** Saturn's ring as a radial alpha gradient with a Cassini-like gap, instead of a flat disc. */
function ringTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 2;
  const g = canvas.getContext('2d');
  if (g) {
    const grad = g.createLinearGradient(0, 0, 256, 0);
    grad.addColorStop(0, 'rgba(205,187,140,0)');
    grad.addColorStop(0.08, 'rgba(205,187,140,0.5)');
    grad.addColorStop(0.3, 'rgba(226,210,166,0.85)');
    grad.addColorStop(0.55, 'rgba(205,187,140,0.8)');
    grad.addColorStop(0.62, 'rgba(120,105,80,0.15)');
    grad.addColorStop(0.68, 'rgba(216,199,153,0.7)');
    grad.addColorStop(0.9, 'rgba(205,187,140,0.45)');
    grad.addColorStop(1, 'rgba(205,187,140,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 2);
  }
  return new THREE.CanvasTexture(canvas);
}

// Round points that twinkle each at their own pace; size and alpha carry each star's character.
const STAR_VERTEX = /* glsl */ `
  attribute float aSize;
  attribute float aPhase;
  attribute vec3 aColor;
  uniform float uTime;
  uniform float uPixelRatio;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vColor = aColor;
    vAlpha = 0.72 + 0.28 * sin(uTime * (0.35 + aPhase) + aPhase * 40.0);
    gl_PointSize = aSize * uPixelRatio * (0.8 + 0.2 * vAlpha);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const STAR_FRAGMENT = /* glsl */ `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    gl_FragColor = vec4(vColor, smoothstep(0.5, 0.05, d) * vAlpha);
  }
`;

export class SolarView {
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.05, 6000);
  private readonly controls: OrbitControls;
  private readonly meshes = new Map<SolarLabelKey, THREE.Mesh>();
  private readonly labelLayer = document.createElement('div');
  private readonly vignette = document.createElement('div');
  private readonly labels = new Map<SolarLabelKey, HTMLElement>();
  private readonly orbitLines = new THREE.Group();
  private readonly trails = new Map<PlanetName, { geometry: THREE.BufferGeometry; points: THREE.Vector3[] }>();
  private readonly moonRing: THREE.LineLoop;
  private readonly glow = glowTexture();
  private readonly textures: THREE.Texture[] = [this.glow];
  private readonly halos = new Map<SolarLabelKey, THREE.Sprite>();
  private readonly sunHalos: { sprite: THREE.Sprite; width: number; opacity: number; speed: number; phase: number }[] =
    [];
  private starUniforms?: { uTime: { value: number }; uPixelRatio: { value: number } };
  private readonly hitTargets: THREE.Mesh[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly resize: ResizeObserver;
  private readonly motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private lastTickMs = 0;
  private elapsedS = 0;
  private hovered: SolarBodyKey | null = null;
  private press: { x: number; y: number; at: number } | null = null;
  private flying = false;
  private frame = 0;
  private looping = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private driftWanted = true;
  // The entry dolly: the camera starts a little further out and eases home.
  private introK: number;
  private readonly introFrom = new THREE.Vector3(0, 225, 322);
  private readonly introTo = new THREE.Vector3(0, 150, 215);
  private introStart = 0;
  /** The opening's hold, as the Earth orbit's radius in pixels; null once the app has opened. */
  private hold: number | null;
  /** True while the opening moves the camera and draws each frame itself. */
  private introDriven = false;
  /** During the opening's hold: whether the hidden view has drawn since it last changed (which readies the GPU). */
  private warm = false;
  private insets: Insets = NO_INSETS;
  private readonly look = new LookOffset();
  private readonly loads: Promise<void>[] = [];
  private readonly scratch = new THREE.Vector3();
  private readonly frameListeners = new Set<() => void>();
  /** Bodies whose name chip is hidden, because the app shows a card for them instead. */
  private hiddenLabels: ReadonlySet<SolarLabelKey> = new Set();
  /** Each label's size on screen, measured once it shows (the text never changes). */
  private readonly labelSize = new Map<SolarLabelKey, { w: number; h: number }>();
  /** The world to pull back from once the planets are placed; null when there is none, or once it has begun. */
  private arrival: SolarBodyKey | null;
  /** True once the planets are placed and the pull back waits only for the world's colour map. */
  private arriving = false;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly opts: SolarViewOptions,
  ) {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    // Far enough back that Neptune's orbit (radius about 77) fits in the frame.
    this.hold = opts.introRingPx ?? null;
    this.arrival = this.hold === null ? (opts.arriveFrom ?? null) : null;
    this.introK = this.motion.matches || this.hold !== null || this.arrival !== null ? 1 : 0;
    if (this.hold !== null) this.driftWanted = false;
    // Coming back from a world, nothing is drawn until the planets are placed and the camera is beside that world.
    if (this.arrival !== null) this.flying = true;
    this.camera.position.copy(this.introK ? this.introTo : this.introFrom);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.minDistance = 2;
    this.controls.maxDistance = 400;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.autoRotateSpeed = 0.12;
    this.controls.enabled = this.hold === null && this.arrival === null;
    this.controls.addEventListener('change', () => this.requestRender());
    // Grabbing the view ends the entry dolly and the idle drift; the drift returns after a quiet while.
    this.controls.addEventListener('start', () => {
      this.introK = 1;
      this.driftWanted = false;
      clearTimeout(this.idleTimer);
    });
    this.controls.addEventListener('end', () => {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        this.driftWanted = true;
      }, IDLE_DRIFT_AFTER_MS);
    });

    const light = new THREE.PointLight(0xffffff, 3, 0, 0);
    this.scene.add(light, new THREE.AmbientLight(0x8090b0, 0.08), this.orbitLines, this.stars(), ...this.haze());
    for (const key of Object.keys(LOOK) as SolarLabelKey[]) this.addBody(key);

    // The Moon's own little orbit, so its dot beside the Earth reads as a companion.
    const circle = new THREE.BufferGeometry().setFromPoints(
      new THREE.EllipseCurve(0, 0, MOON_ORBIT_SCENE, MOON_ORBIT_SCENE).getPoints(48),
    );
    this.moonRing = new THREE.LineLoop(
      circle,
      new THREE.LineBasicMaterial({ color: ORBIT_COLOR, transparent: true, opacity: 0.5 }),
    );
    this.moonRing.rotation.x = Math.PI / 2;
    this.scene.add(this.moonRing);

    // The edges fall off into dark, which keeps the eye on the plane of the planets.
    Object.assign(this.vignette.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      background: 'radial-gradient(ellipse at 50% 42%, transparent 55%, rgba(2, 4, 10, 0.55) 100%)',
    });
    container.appendChild(this.vignette);

    Object.assign(this.labelLayer.style, {
      position: 'absolute',
      inset: '0',
      overflow: 'hidden',
      pointerEvents: 'none',
    });
    container.appendChild(this.labelLayer);
    // Measured sizes are from the fallback font until the real one arrives.
    void document.fonts?.ready.then(() => this.labelSize.clear());
    for (const key of Object.keys(LOOK) as SolarLabelKey[]) this.addLabel(key);
    // The names come in once the opening has handed over the camera, or near the end of the pull back from a world.
    if (this.hold !== null || this.arrival !== null) this.labelLayer.style.opacity = '0';

    const canvas = this.renderer.domElement;
    if (!this.motion.matches) {
      canvas.style.opacity = '0';
      canvas.style.transition = 'opacity 700ms ease';
      // The pull back from a world fades the picture in as it starts.
      if (this.arrival === null)
        requestAnimationFrame(() => {
          canvas.style.opacity = '1';
        });
    }
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.motion.addEventListener('change', this.onMotionChange);

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(container);
    this.fit();
    this.introStart = performance.now();
    this.startLoop();
  }

  /** One orbit per planet, as x, y, z triples in km. */
  setOrbits(orbits: Record<PlanetName, Float32Array>): void {
    for (const child of [...this.orbitLines.children]) {
      this.orbitLines.remove(child);
      (child as THREE.LineLoop).geometry.dispose();
    }
    this.trails.clear();
    const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 });
    const p = new THREE.Vector3();
    for (const name of PLANET_NAMES) {
      const km = orbits[name];
      const points: THREE.Vector3[] = [];
      for (let i = 0; i < km.length; i += 3) points.push(toScene([km[i], km[i + 1], km[i + 2]], p).clone());
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(points.length * 3), 3));
      this.trails.set(name, { geometry, points });
      this.updateTrail(name);
      this.orbitLines.add(new THREE.LineLoop(geometry, material));
    }
    this.requestRender();
  }

  setSnapshot(s: SolarSnapshot): void {
    for (const name of PLANET_NAMES) {
      toScene(s.positionsKm[name], this.mesh(name).position);
      this.updateTrail(name);
    }
    const earth = this.mesh('earth').position;
    const away = toScene(s.positionsKm.moon).normalize();
    this.mesh('moon').position.copy(earth).addScaledVector(away, MOON_ORBIT_SCENE);
    this.moonRing.position.copy(earth);
    this.requestRender();
    if (this.arrival !== null && !this.arriving) this.arrive();
  }

  /** Calls `listener` after every draw, for overlays that must move with the picture; returns a function that stops it. */
  addFrameListener(listener: () => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  /** Lights a body and its name as if the pointer were on it (the phone's dial picks bodies this way); null for none. */
  highlight(body: SolarBodyKey | null): void {
    this.setHover(body);
  }

  /** Hides the name chips of these bodies, for the ones the app labels with a card of its own. */
  setHiddenLabels(keys: ReadonlySet<SolarLabelKey>): void {
    this.hiddenLabels = keys;
    this.requestRender();
  }

  /** Turns the camera a little on top of its controls, as the phone's tilt-to-look asks; zero for none. */
  setLook(yawRad: number, pitchRad: number): void {
    if (this.look.set(yawRad, pitchRad)) this.requestRender();
  }

  /** How much of the canvas the app's panels cover; the Sun moves to the middle of the rest. */
  setInsets(insets: Insets): void {
    this.insets = insets;
    this.fit();
  }

  /** Resolves when every colour map has loaded or failed to. */
  texturesReady(): Promise<void> {
    return Promise.all(this.loads).then(() => undefined);
  }

  /** Where a body is on the page. */
  projectBody(key: SolarLabelKey): ScreenPoint {
    this.camera.updateMatrixWorld();
    return toScreen(this.mesh(key).position, this.camera, this.renderer.domElement, this.scratch);
  }

  /**
   * A planet's orbit as drawn, on the page: `n` points going round the Sun, the i-th the one closest to the direction
   * −180° + 360° × i / n on screen (0° to the right, turning clockwise), so it lines up point by point with a circle.
   */
  projectOrbit(name: PlanetName, n: number): { x: number; y: number }[] {
    const trail = this.trails.get(name);
    if (!trail) return [];
    const canvas = this.renderer.domElement;
    const sun = this.projectBody('sun');
    const rect = canvas.getBoundingClientRect();
    const points = trail.points.map((p) => toScreen(p, this.camera, canvas, this.scratch, rect));
    // Sorted by their angle round the Sun, the samples can be matched to the n directions in one sweep.
    const around = points
      .map((p) => ({ x: p.x, y: p.y, a: Math.atan2(p.y - sun.y, p.x - sun.x) }))
      .sort((p, q) => p.a - q.a);
    const m = around.length;
    const gap = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    let k = 0;
    return Array.from({ length: n }, (_, i) => {
      const want = ((i / n) * 2 - 1) * Math.PI;
      while (k + 1 < m && around[k + 1].a <= want) k++;
      const below = around[k];
      const above = around[(k + 1) % m];
      const best = gap(below.a, want) <= gap(above.a, want) ? below : above;
      return { x: best.x, y: best.y };
    });
  }

  /**
   * The opening's camera move, from straight over the Sun (`k` = 0) back and down to the usual view (`k` = 1); the
   * caller eases `k` and calls this once a frame, and each call draws.
   */
  setIntroProgress(k: number): void {
    if (this.hold === null) return;
    this.introDriven = true;
    const from = this.holdPose();
    const r0 = from.length();
    const r1 = this.introTo.length();
    // Distance eases on a log scale, so the pull-back reads as a steady zoom; the tilt goes straight.
    const r = r0 * (r1 / r0) ** k;
    const phi0 = Math.acos(from.y / r0);
    const phi = phi0 + (Math.acos(this.introTo.y / r1) - phi0) * k;
    this.camera.position.set(0, r * Math.cos(phi), r * Math.sin(phi));
    this.controls.target.set(0, 0, 0);
    this.camera.lookAt(this.controls.target);
    this.draw();
  }

  /** Ends the opening: the usual view, the names, the pointer and the idle drift. */
  endIntro(): void {
    if (this.hold === null) return;
    this.hold = null;
    this.introDriven = false;
    this.camera.position.copy(this.introTo);
    this.controls.target.set(0, 0, 0);
    this.controls.enabled = true;
    this.driftWanted = true;
    this.labelLayer.style.transition = 'opacity 600ms ease';
    this.labelLayer.style.opacity = '1';
    this.controls.update();
    this.requestRender();
  }

  /** Dive toward a body until it fills the view; resolves on arrival. */
  flyTo(body: SolarBodyKey, durationMs = 1800): Promise<void> {
    // A dive asked for during the pull back from a world takes over from where the camera is.
    cancelAnimationFrame(this.frame);
    this.arrival = null;
    const target = this.mesh(body).position.clone();
    const size = LOOK[body].size;
    // Approach from the side facing the camera, so the body never swings out of view.
    const from = this.camera.position.clone().sub(target).normalize();
    const endPos = target.clone().addScaledVector(from, Math.max(size * 5, 1.2));
    const startPos = this.camera.position.clone();
    const startTarget = this.controls.target.clone();
    reportFlight({
      durationMs,
      zoom: zoomSize(startPos.distanceTo(startTarget), endPos.distanceTo(target)),
      turnRad: angleBetween(startTarget.clone().sub(startPos), target.clone().sub(startPos)),
    });
    this.introK = 1;
    this.setHover(null);
    this.flying = true;
    this.controls.enabled = false;
    return new Promise((resolve) => {
      const t0 = performance.now();
      const step = () => {
        const k = durationMs <= 0 ? 1 : Math.min(1, (performance.now() - t0) / durationMs);
        const e = easeInOut(k);
        this.camera.position.lerpVectors(startPos, endPos, e);
        this.controls.target.lerpVectors(startTarget, target, e);
        this.camera.lookAt(this.controls.target);
        this.draw();
        if (k < 1) this.frame = requestAnimationFrame(step);
        else {
          this.frame = 0;
          resolve();
        }
      };
      this.frame = requestAnimationFrame(step);
    });
  }

  /** Waits a moment for the world's colour map, so it looks itself from the first frame, then pulls back from it. */
  private arrive(): void {
    this.arriving = true;
    const waitMs = this.motion.matches ? 0 : PULL_BACK_WAIT_MS;
    const waited = new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    void Promise.race([this.texturesReady(), waited])
      // Shaders build in the background where the GPU allows, rather than in the flight's first frame.
      .then(() => this.renderer.compileAsync(this.scene, this.camera))
      .catch(() => undefined)
      .then(() => {
        const body = this.arrival;
        // A dive asked for meanwhile (`flyTo`) or the view closing calls it off.
        if (this.disposed || body === null) return;
        this.arrival = null;
        this.pullBack(body);
      });
  }

  /**
   * The way back out, `flyTo` in reverse: from close beside a world the camera backs away to the usual view of the whole
   * system. Its distance eases on a log scale, so it reads as one steady zoom; it swings from the world's day side round
   * to the usual angle; and its aim slides from the world to the Sun as fast as the world shrinks, so the world drifts
   * smoothly from the middle of the picture to its place in the system.
   */
  private pullBack(body: SolarBodyKey): void {
    const durationMs = this.motion.matches ? 0 : PULL_BACK_MS;
    const world = this.mesh(body).position.clone();
    const sun = new THREE.Vector3();
    const d0 = LOOK[body].size * PULL_BACK_FROM_RADII;
    const d1 = this.introTo.length();
    const dir1 = this.introTo.clone().normalize();
    const sunward = world.clone().negate().setY(0).normalize();
    const dir0 = dir1.clone().addScaledVector(sunward, PULL_BACK_SUNWARD).normalize();
    const swing = new THREE.Quaternion().setFromUnitVectors(dir0, dir1);
    const turn = new THREE.Quaternion();
    const dir = new THREE.Vector3();
    /** Puts the camera where the flight is at eased progress `e`. */
    const place = (e: number) => {
      const d = d0 * (d1 / d0) ** e;
      this.controls.target.lerpVectors(world, sun, (d - d0) / (d1 - d0));
      dir.copy(dir0).applyQuaternion(turn.identity().slerp(swing, e));
      this.camera.position.copy(this.controls.target).addScaledVector(dir, d);
      this.camera.lookAt(this.controls.target);
    };
    const fly = () => this.flyBack(durationMs, place, d0, d1, dir0.angleTo(dir1));
    // With reduced motion it is a cut straight to the usual view.
    if (durationMs <= 0) {
      fly();
      return;
    }
    // The first picture puts the colour maps on the GPU, which can take a moment: it is drawn unseen, and the flight's
    // clock starts on the frame after it, so no part of the flight is lost to that moment.
    place(0);
    this.draw();
    this.frame = requestAnimationFrame(fly);
  }

  /** The pull back's frames, from the first one seen to the usual view; `place` sets the camera for each. */
  private flyBack(durationMs: number, place: (e: number) => void, d0: number, d1: number, turnRad: number): void {
    reportFlight({ durationMs, zoom: zoomSize(d0, d1), turnRad, back: true });
    const canvas = this.renderer.domElement;
    canvas.style.transition = 'opacity 450ms ease';
    canvas.style.opacity = '1';
    let named = false;
    const t0 = performance.now();
    const step = () => {
      const k = durationMs <= 0 ? 1 : Math.min(1, (performance.now() - t0) / durationMs);
      place(easeInOut(k));
      // The names come back as the whole system comes into view.
      if (!named && k >= 0.6) {
        named = true;
        this.labelLayer.style.transition = durationMs > 0 ? 'opacity 700ms ease' : '';
        this.labelLayer.style.opacity = '1';
      }
      this.draw();
      if (k < 1) {
        this.frame = requestAnimationFrame(step);
        return;
      }
      this.frame = 0;
      this.flying = false;
      this.camera.position.copy(this.introTo);
      this.controls.target.set(0, 0, 0);
      this.controls.enabled = true;
      this.controls.update();
      this.lastTickMs = performance.now();
      this.opts.onArrive?.();
      this.requestRender();
    };
    step();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.stopLoop();
    clearTimeout(this.idleTimer);
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointerleave', this.onPointerLeave);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.motion.removeEventListener('change', this.onMotionChange);
    this.resize.disconnect();
    this.controls.dispose();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.Points) {
        o.geometry.dispose();
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
          m.dispose();
        });
      } else if (o instanceof THREE.Sprite) o.material.dispose();
    });
    for (const texture of this.textures) texture.dispose();
    this.renderer.dispose();
    this.vignette.remove();
    this.labelLayer.remove();
    this.renderer.domElement.remove();
  }

  private mesh(key: SolarLabelKey): THREE.Mesh {
    const m = this.meshes.get(key);
    if (!m) throw new Error(`no mesh for ${key}`);
    return m;
  }

  private addBody(key: SolarLabelKey): void {
    const { size, color } = LOOK[key];
    const material = key === 'sun' ? new THREE.MeshBasicMaterial({ color }) : new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(size, 40, 24), material);
    // Tilt around Z holds still while the spin turns Y underneath it ('ZXY': Y applies first, then the tilt).
    mesh.rotation.order = 'ZXY';
    mesh.rotation.z = TILT[key] ?? 0;
    const url = key === 'sun' ? undefined : this.opts.textures?.[key];
    if (url) {
      this.loads.push(
        loadMap(url).then(
          (map) => {
            if (this.disposed) {
              map.dispose();
              return;
            }
            map.colorSpace = THREE.SRGBColorSpace;
            this.textures.push(map);
            material.map = map;
            material.color.set(0xffffff);
            material.needsUpdate = true;
            this.requestRender();
          },
          // A missing map leaves the body its flat colour, as before.
          () => undefined,
        ),
      );
    }
    // The Sun gets a breathing corona in layers; each planet a faint halo in its own colour.
    if (key === 'sun') {
      for (const [haloColor, width, opacity, speed, phase] of [
        [0xffe2a0, size * 4, 1, 0.9, 0],
        [0xffa040, size * 10, 0.45, 0.6, 2.1],
        [0xff7020, size * 16, 0.16, 0.45, 4.4],
      ] as const) {
        const sprite = this.halo(haloColor, width, opacity);
        this.sunHalos.push({ sprite, width, opacity, speed, phase });
        mesh.add(sprite);
      }
    } else {
      const sprite = this.halo(color, size * 3.6, 0.55);
      this.halos.set(key, sprite);
      mesh.add(sprite);
    }
    if (key === 'saturn') {
      const geometry = new THREE.RingGeometry(size * 1.35, size * 2.2, 64);
      // Remap the UVs so the texture runs across the ring's width instead of across its face.
      const pos = geometry.getAttribute('position');
      const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const r = Math.hypot(pos.getX(i), pos.getY(i));
        uv.setXY(i, (r - size * 1.35) / (size * 0.85), 0.5);
      }
      const map = ringTexture();
      this.textures.push(map);
      const ring = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide, transparent: true, depthWrite: false }),
      );
      ring.rotation.x = Math.PI / 2;
      mesh.add(ring);
    }
    // Every planet takes the pointer on a larger, invisible hit sphere around it; the ones you can fly into get a bigger one.
    if (key !== 'sun') {
      const hit = new THREE.Mesh(
        new THREE.SphereGeometry(Math.max(size * (this.opts.navigable.has(key) ? 1.9 : 1.4), 0.55), 12, 8),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      hit.userData.body = key;
      this.hitTargets.push(hit);
      mesh.add(hit);
    }
    this.meshes.set(key, mesh);
    this.scene.add(mesh);
  }

  private halo(color: number, width: number, opacity: number): THREE.Sprite {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.glow,
        color,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    sprite.scale.set(width, width, 1);
    return sprite;
  }

  /** Brighten the trail where the planet is and fade it along the path behind, like a comet's tail. */
  private updateTrail(name: PlanetName): void {
    const trail = this.trails.get(name);
    if (!trail) return;
    const planet = this.mesh(name).position;
    if (planet.lengthSq() === 0) return;
    let head = 0;
    let bestD = Infinity;
    trail.points.forEach((point, i) => {
      const d = point.distanceToSquared(planet);
      if (d < bestD) {
        bestD = d;
        head = i;
      }
    });
    const colors = trail.geometry.getAttribute('color') as THREE.BufferAttribute;
    const n = trail.points.length;
    const tail = Math.max(8, Math.floor(n * TRAIL_FRACTION));
    const base = new THREE.Color(ORBIT_COLOR);
    const bright = new THREE.Color(LOOK[name].color).lerp(new THREE.Color(0xffffff), 0.35);
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      // The orbit samples run forward in time, so the tail is the stretch of falling index behind the head.
      const lag = (head - i + n) % n;
      c.copy(bright).lerp(base, Math.min(1, lag / tail) ** 0.6);
      colors.setXYZ(i, c.r, c.g, c.b);
    }
    colors.needsUpdate = true;
  }

  private addLabel(key: SolarLabelKey): void {
    const go = key !== 'sun' && this.opts.navigable.has(key);
    const el = document.createElement(go ? 'button' : 'span');
    el.textContent = this.opts.labels[key];
    // Every name sits on a small dark chip; the ones you can fly into are brighter and take the pointer.
    Object.assign(el.style, {
      position: 'absolute',
      transform: 'translate(-50%, 0)',
      padding: go ? '4px 8px' : '2px 7px',
      font: '500 12px "IBM Plex Sans", system-ui, sans-serif',
      color: go ? '#e8edf7' : '#8e9ab5',
      background: 'rgba(8, 13, 26, 0.8)',
      border: `1px solid ${go ? '#3a4c80' : '#22304f'}`,
      borderRadius: '6px',
      whiteSpace: 'nowrap',
      pointerEvents: go ? 'auto' : 'none',
      cursor: go ? 'pointer' : 'default',
      transition: 'border-color 0.2s, box-shadow 0.2s',
    });
    if (go) {
      (el as HTMLButtonElement).type = 'button';
      el.addEventListener('click', () => this.opts.onSelect?.(key as SolarBodyKey));
      // Hovering the chip lights the planet, and hovering the planet lights the chip.
      el.addEventListener('mouseenter', () => this.setHover(key as SolarBodyKey));
      el.addEventListener('mouseleave', () => this.setHover(null));
    }
    // The scene's cards keep clear of the names (see the app's callouts).
    el.dataset.avoid = '';
    this.labels.set(key, el);
    this.labelLayer.appendChild(el);
  }

  /** An even sky of twinkling stars plus a denser, dimmer band for the Milky Way. */
  private stars(): THREE.Points {
    const even = 2400;
    const band = 1400;
    const n = even + band;
    const pos = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const phase = new Float32Array(n);
    const color = new Float32Array(n * 3);
    // A fixed seed keeps the sky identical on every load.
    let s = 12345;
    const rand = () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
    // The band's plane, tilted like the Milky Way across a night sky.
    const bandTilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(1.1, 0, 0.5));
    const p = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const inBand = i >= even;
      if (inBand) {
        // Near the band plane: a thin gaussian spread of latitude.
        const lat = (rand() + rand() + rand() - 1.5) * 0.12;
        const a = 2 * Math.PI * rand();
        p.set(Math.cos(a) * Math.cos(lat), Math.sin(lat), Math.sin(a) * Math.cos(lat)).applyQuaternion(bandTilt);
      } else {
        const z = 2 * rand() - 1;
        const a = 2 * Math.PI * rand();
        const r = Math.sqrt(1 - z * z);
        p.set(r * Math.cos(a), z, r * Math.sin(a));
      }
      pos.set([1800 * p.x, 1800 * p.y, 1800 * p.z], i * 3);
      size[i] = inBand ? 0.8 + rand() * 0.8 : 1 + rand() * 1.8;
      phase[i] = rand() * Math.PI * 2;
      // Mostly white, some blue-white, a few warm; band stars sit dimmer.
      const pick = rand();
      const [r, g, b] = pick < 0.7 ? [1, 1, 1] : pick < 0.88 ? [0.73, 0.82, 1] : [1, 0.85, 0.69];
      const dim = (inBand ? 0.4 : 0.75) + rand() * 0.25;
      color.set([r * dim, g * dim, b * dim], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    g.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
    this.starUniforms = { uTime: { value: 0 }, uPixelRatio: { value: this.renderer.getPixelRatio() } };
    return new THREE.Points(
      g,
      new THREE.ShaderMaterial({
        uniforms: this.starUniforms,
        vertexShader: STAR_VERTEX,
        fragmentShader: STAR_FRAGMENT,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
  }

  /** Two very faint far-off glows that give the black some depth. */
  private haze(): THREE.Sprite[] {
    const one = this.halo(0x24406e, 700, 0.07);
    one.position.set(900, 250, -1300);
    const two = this.halo(0x4a2a5e, 600, 0.05);
    two.position.set(-1100, -200, 800);
    return [one, two];
  }

  // Pointer hover and click on the planets themselves; a click only counts if it did not drag.
  private readonly onPointerMove = (e: PointerEvent): void => {
    this.setHover(this.flying ? null : this.pick(e));
  };
  private readonly onPointerDown = (e: PointerEvent): void => {
    this.press = { x: e.clientX, y: e.clientY, at: performance.now() };
  };
  private readonly onPointerUp = (e: PointerEvent): void => {
    const press = this.press;
    this.press = null;
    if (!press || this.flying) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6 || performance.now() - press.at > 500) return;
    const body = this.pick(e);
    if (body) (this.opts.navigable.has(body) ? this.opts.onSelect : this.opts.onPoint)?.(body);
  };
  private readonly onPointerLeave = (): void => this.setHover(null);
  private readonly onVisibility = (): void => (document.hidden ? this.stopLoop() : this.startLoop());
  private readonly onMotionChange = (): void => {
    if (this.motion.matches) this.stopLoop();
    else this.startLoop();
  };

  private pick(e: PointerEvent): SolarBodyKey | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    this.raycaster.setFromCamera(
      new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      this.camera,
    );
    const hit = this.raycaster.intersectObjects(this.hitTargets, false)[0];
    return hit ? (hit.object.userData.body as SolarBodyKey) : null;
  }

  private setHover(body: SolarBodyKey | null): void {
    if (body === this.hovered) return;
    const style = (key: SolarBodyKey, on: boolean) => {
      const halo = this.halos.get(key);
      if (halo) halo.material.opacity = on ? 0.95 : 0.55;
      const el = this.labels.get(key);
      if (el) {
        el.style.borderColor = on ? '#5ba9ff' : this.opts.navigable.has(key) ? '#3a4c80' : '#22304f';
        el.style.boxShadow = on ? '0 0 14px rgba(91, 169, 255, 0.4)' : 'none';
      }
    };
    if (this.hovered) style(this.hovered, false);
    this.hovered = body;
    if (body) style(body, true);
    this.opts.onHover?.(body);
    this.renderer.domElement.style.cursor = body ? 'pointer' : '';
    this.requestRender();
  }

  /** The living parts: spin, the Sun's breathing, twinkle, damping and the idle drift. */
  private readonly tick = (): void => {
    this.looping = requestAnimationFrame(this.tick);
    if (this.flying) return;
    const now = performance.now();
    // Clamp the step so a stall (a hidden tab, a long frame) does not jump the motion.
    const dt = Math.min((now - this.lastTickMs) / 1000, 0.1);
    this.lastTickMs = now;
    this.elapsedS += dt;
    const t = this.elapsedS;
    if (this.introK < 1) {
      this.introK = Math.min(1, (performance.now() - this.introStart) / 1600);
      this.camera.position.lerpVectors(this.introFrom, this.introTo, easeInOut(this.introK));
    }
    for (const [key, mesh] of this.meshes) {
      const spin = SPIN[key];
      if (spin) mesh.rotation.y += spin * dt;
    }
    for (const h of this.sunHalos) {
      const k = 1 + 0.05 * Math.sin(t * h.speed + h.phase);
      h.sprite.scale.set(h.width * k, h.width * k, 1);
      h.sprite.material.opacity = h.opacity * (0.92 + 0.1 * Math.sin(t * h.speed * 1.7 + h.phase));
    }
    if (this.starUniforms) this.starUniforms.uTime.value = t;
    // While the opening moves the camera it also draws, once a frame. Before that its screen hides the view entirely,
    // so the view draws only once after each change: enough to have shaders built and maps on the GPU before the
    // flight, without taking time from the emblem.
    if (this.introDriven) return;
    if (this.hold !== null) {
      if (!this.warm) {
        this.warm = true;
        this.draw();
      }
      return;
    }
    this.controls.autoRotate = this.driftWanted && this.introK >= 1;
    this.controls.update();
    this.draw();
  };

  private startLoop(): void {
    if (this.looping || this.motion.matches || document.hidden) return;
    this.lastTickMs = performance.now();
    this.looping = requestAnimationFrame(this.tick);
  }

  private stopLoop(): void {
    cancelAnimationFrame(this.looping);
    this.looping = 0;
  }

  private draw(): void {
    this.look.apply(this.camera);
    this.renderer.render(this.scene, this.camera);
    const { clientWidth: w, clientHeight: h } = this.container;
    const p = new THREE.Vector3();
    // Names are placed in order of importance; one that would overlap a name already placed waits until there is room.
    const taken: { x: number; y: number; w: number; h: number }[] = [];
    for (const key of LABEL_RANK) {
      const el = this.labels.get(key);
      if (!el) continue;
      p.copy(this.mesh(key).position).project(this.camera);
      let visible = !this.hiddenLabels.has(key) && p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1;
      const x = ((p.x + 1) / 2) * w;
      // The Moon sits beside the Earth, so its label goes above and the Earth's below.
      const offset = key === 'moon' ? -(LOOK[key].size * 6 + 34) : LOOK[key].size * 6 + 6;
      const y = ((1 - p.y) / 2) * h + offset;
      const size = this.labelSize.get(key);
      if (visible && size) {
        const box = { x: x - size.w / 2 - 3, y: y - 3, w: size.w + 6, h: size.h + 6 };
        const clash = taken.some(
          (t) => box.x < t.x + t.w && t.x < box.x + box.w && box.y < t.y + t.h && t.y < box.y + box.h,
        );
        if (clash) visible = false;
        else taken.push(box);
      }
      const display = visible ? '' : 'none';
      if (el.style.display !== display) el.style.display = display;
      if (!visible) continue;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      if (!size && el.offsetWidth > 0) this.labelSize.set(key, { w: el.offsetWidth, h: el.offsetHeight });
    }
    for (const listener of this.frameListeners) listener();
  }

  private requestRender(): void {
    this.warm = false;
    if (this.frame || this.flying || this.looping) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  /**
   * Straight over the Sun (a hair towards the usual view, so north stays up), where the Earth's orbit is `hold` pixels
   * in radius.
   */
  private holdPose(): THREE.Vector3 {
    const earth = this.trails.get('earth');
    const radius = earth ? earth.points.reduce((sum, p) => sum + p.length(), 0) / earth.points.length : radial(1);
    const h = this.container.clientHeight || 1;
    const d = (radius * h) / (2 * (this.hold ?? 1) * Math.tan((this.camera.fov * Math.PI) / 360));
    const phi = 0.0005;
    return new THREE.Vector3(0, d * Math.cos(phi), d * Math.sin(phi));
  }

  private fit(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    fitCamera(this.camera, w, h, this.insets);
    if (this.hold !== null && !this.introDriven) {
      this.camera.position.copy(this.holdPose());
      this.camera.lookAt(this.controls.target);
    }
    this.requestRender();
  }
}
