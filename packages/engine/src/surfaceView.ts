import { clampMove, EYE_HEIGHT_M, gridUpAt, type LocalGrid, type MoveBlock } from '@siteline/physics';
import * as THREE from 'three';
import {
  clampPitch,
  DEFAULT_DESCENT,
  type DescentPlan,
  descentPose,
  lookAngles,
  type Pose,
  walkStep,
} from './surfaceMotion';

/**
 * The surface view ("Land Here"): the terrain around a landing point at real scale, the Sun and the Earth where they
 * are at the chosen moment, an illustrative descent, and a first-person walk at eye height.
 *
 * Scene units are metres in the landing point's local frame: x east, y up, z south (three.js's −z is north), with the
 * landing point's ground at the origin. The walkable ground stays within 2 km of it, so 32-bit positions are exact to a
 * fraction of a millimetre there: the origin itself is the floating origin. The far rings reach 300 km, where 32 bits
 * still place a vertex within 3 cm. The logarithmic depth buffer keeps 5 cm to 1,200 km in one view.
 */

type V3 = readonly [number, number, number];

/** One ring of terrain, as the physics worker builds it. */
export interface SurfaceMeshData {
  name: string;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  size: number;
  spacingM: number;
  halfM: number;
  /** Local up of each node, for rings the camera can be over. */
  up?: Float32Array;
}

/** The Sun and the Earth at the moment shown, from the landing point (local east, north, up). */
export interface SurfaceLighting {
  sunDir: V3;
  sunRadiusDeg: number;
  earthDir: V3;
  earthRadiusDeg: number;
  /** The share of the Sun's disc each node of each ring sees above the terrain, ring by ring; omit to keep the last. */
  sunlit?: readonly Float32Array[];
}

export type SurfaceMode = 'idle' | 'descent' | 'explore';

export interface LabelPoint {
  x: number;
  y: number;
  /** On screen and in front of the camera. */
  shown: boolean;
}

export type SurfaceLabelKey = 'sun' | 'earth' | 'touchdown' | 'north' | 'east' | 'south' | 'west';
export type SurfaceLabels = Record<SurfaceLabelKey, LabelPoint>;

export interface SurfaceViewOptions {
  reducedMotion?: boolean;
  eyeHeightM?: number;
  onMode?: (mode: SurfaceMode) => void;
  /** Why the last step was refused (the edge of the terrain, a hole in it), and null once walking freely again. */
  onBlocked?: (reason: MoveBlock | null) => void;
  onPointerLock?: (locked: boolean) => void;
  /** Where the eye came to rest after moving: local east and north, metres. */
  onSettled?: (east: number, north: number) => void;
  /** Screen positions of the labels, after every frame that moved them (CSS pixels in the container). */
  onLabels?: (labels: SurfaceLabels) => void;
  /** The graphics context was lost (the GPU reset or ran out of memory); the view has stopped. */
  onLost?: () => void;
}

/** How far the Sun and the Earth are drawn: beyond the far terrain (300 km, 424 km at the corners), inside the far plane. */
const SKY_M = 800_000;
/** Walking pace, and the much faster pace Shift gives for getting across the patch (not a walking speed). */
export const WALK_M_PER_S = 1.4;
export const FAST_M_PER_S = 12;
const TURN_RAD_PER_S = (70 * Math.PI) / 180;
const LOOK_RAD_PER_PX = 0.0024;
const DRAG_RAD_PER_PX = 0.0045;
/** How close to the edge of the walkable terrain the eye may go, metres. */
export const EDGE_MARGIN_M = 25;
const SETTLE_MS = 350;

const toThree = (v: V3, out = new THREE.Vector3()) => out.set(v[0], v[2], -v[1]);

const SUN_POWER = 1.7;

/**
 * The exposure for a Sun at a given height, as a camera would set it: the Sun near the horizon lights level ground
 * thinly, so the picture is brightened to show level ground looked at a few metres ahead (μ ≈ 0.1) as it would show
 * under a higher Sun. Shadows stay black and sunlit slopes still outshine level ground; the brightness on screen is a
 * picture's, not a measurement.
 */
export function exposureFor(sunElevDeg: number): number {
  const mu0 = Math.max(0, Math.sin((sunElevDeg * Math.PI) / 180));
  const level = (2 * mu0) / (mu0 + 0.1);
  return Math.min(MAX_EXPOSURE, LEVEL_GROUND_SHOWN / Math.max(LEVEL_GROUND_SHOWN / MAX_EXPOSURE, level));
}

/** How bright level ground a few metres ahead is shown, before tone mapping; and the most the picture is brightened. */
export const LEVEL_GROUND_SHOWN = 0.35;
const MAX_EXPOSURE = 6;

/** The compass points, just under the level line where the horizon is. */
const COMPASS: readonly [SurfaceLabelKey, THREE.Vector3][] = [
  ['north', new THREE.Vector3(0, -0.004, -1).normalize()],
  ['east', new THREE.Vector3(1, -0.004, 0).normalize()],
  ['south', new THREE.Vector3(0, -0.004, 1).normalize()],
  ['west', new THREE.Vector3(-1, -0.004, 0).normalize()],
];

const TERRAIN_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float sunlit;
varying vec3 vNormal;
varying vec3 vWorld;
varying float vSunlit;
void main() {
  vNormal = normal;
  vSunlit = sunlit;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
  #include <logdepthbuf_vertex>
}
`;

/**
 * The regolith under the Sun: Lommel-Seeliger brightness (μ₀ / (μ₀ + μ), the usual first model of the Moon's
 * surface), times the share of the Sun's disc the terrain leaves in view at that point. No light reaches a shadow:
 * there is no air to scatter it, and the faint earthshine is left out. Near the eye the albedo carries a faint
 * illustrative grain so walking has something to see move; it changes no height and fades out by 400 m.
 * The inspection light is a lamp at the eye, tinted so it never passes for sunlight.
 */
const TERRAIN_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 sunDir;
uniform float sunPower;
uniform vec3 albedo;
uniform float detail;
uniform float inspect;
varying vec3 vNormal;
varying vec3 vWorld;
varying float vSunlit;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vNormal);
  vec3 toEye = cameraPosition - vWorld;
  float dist = length(toEye);
  vec3 v = toEye / max(dist, 1e-3);
  float mu0 = dot(n, sunDir);
  float mu = max(dot(n, v), 0.0);
  float ls = mu0 > 0.0 ? 2.0 * mu0 / (mu0 + mu + 1e-4) : 0.0;
  float grain = 1.0;
  if (detail > 0.5) {
    float fade = 1.0 - smoothstep(60.0, 400.0, dist);
    float t = 0.55 * vnoise(vWorld.xz * 0.9) + 0.3 * vnoise(vWorld.xz * 0.23) + 0.15 * vnoise(vWorld.xz * 3.7);
    grain = mix(1.0, 0.86 + 0.28 * t, fade);
  }
  vec3 base = albedo * grain;
  vec3 colour = base * sunPower * ls * vSunlit;
  if (inspect > 0.5) {
    float lamp = mu / (1.0 + dist * dist / 900.0);
    colour += base * vec3(0.5, 0.66, 1.0) * lamp;
  }
  gl_FragColor = vec4(colour, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const EARTH_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vN;
void main() {
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

/** The Earth as a plain sphere lit by the Sun: its phase is right, its oceans and clouds are not drawn. */
const EARTH_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 sunDir;
varying vec3 vN;
void main() {
  #include <logdepthbuf_fragment>
  float lit = max(dot(normalize(vN), sunDir), 0.0);
  vec3 c = vec3(0.16, 0.3, 0.62) * (0.02 + 1.5 * lit) + vec3(0.9) * 0.35 * pow(lit, 3.0);
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** A soft round spot, white at the centre: the Sun's disc and its glare. */
function spotTexture(size: number, falloff: (r: number) => number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      const a = Math.max(0, Math.min(1, falloff(r)));
      data.set([255, 255, 255, Math.round(a * 255)], (y * size + x) * 4);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

export class SurfaceView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(60, 1, 0.05, 1_200_000);
  private readonly canvas: HTMLCanvasElement;
  private readonly resize: ResizeObserver;
  private readonly meshes: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[] = [];
  private readonly uniforms = {
    sunDir: { value: new THREE.Vector3(0, 1, 0) },
    /** The Sun's strength on screen: a fixed power times the exposure (see `exposureFor`). */
    sunPower: { value: SUN_POWER },
    albedo: { value: new THREE.Color(0.5, 0.5, 0.5) },
    inspect: { value: 0 },
  };
  private readonly sunDisc: THREE.Sprite;
  private readonly sunGlare: THREE.Sprite;
  private readonly earth: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly touchdown = new THREE.Group();
  private readonly ring: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private readonly beam: THREE.Mesh;
  private readonly textures: THREE.Texture[] = [];
  /** The ring the eye walks on, and the next one out (the descent passes over it). */
  private readonly walkGrid: LocalGrid;
  private readonly overGrids: LocalGrid[];
  private readonly eyeM: number;
  private readonly reducedMotion: boolean;

  private mode: SurfaceMode = 'idle';
  private pos = { east: 0, north: 0 };
  private heading = 0;
  private pitch = 0;
  /** The heading the walk starts facing and returns to on reset. */
  private homeHeading = 0;
  private sunDir: V3 = [0, 0, 1];
  private earthDir: V3 = [0, 1, 0];
  private sunRadiusDeg = 0.27;
  private earthRadiusDeg = 0.95;
  private descent?: { plan: DescentPlan; startMs: number };
  private descentPoseNow?: Pose;
  private readonly keys = new Set<string>();
  private touch = { forward: 0, right: 0 };
  private drag?: { id: number; x: number; y: number; touch: boolean };
  private blocked: MoveBlock | null = null;
  private blockedAtMs = 0;
  private movedAtMs = 0;
  private settled = true;
  private frame = 0;
  private lastMs = 0;
  private dirty = true;
  private running = false;
  private disposed = false;
  private pixelRatio: number;
  private slowFrames = 0;
  private sampledFrames = 0;
  private readonly labels: SurfaceLabels = {
    sun: { x: 0, y: 0, shown: false },
    earth: { x: 0, y: 0, shown: false },
    touchdown: { x: 0, y: 0, shown: false },
    north: { x: 0, y: 0, shown: false },
    east: { x: 0, y: 0, shown: false },
    south: { x: 0, y: 0, shown: false },
    west: { x: 0, y: 0, shown: false },
  };
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly labelDir = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  /** Where the touchdown label sits: a little above the target ring. */
  private readonly touchdownTop: number;

  constructor(
    private readonly container: HTMLElement,
    data: readonly SurfaceMeshData[],
    private readonly opts: SurfaceViewOptions = {},
  ) {
    this.eyeM = opts.eyeHeightM ?? EYE_HEIGHT_M;
    this.reducedMotion = opts.reducedMotion ?? false;
    const grids = data
      .filter((d) => d.up)
      .map((d): LocalGrid => ({ size: d.size, spacingM: d.spacingM, halfM: d.halfM, up: d.up as Float32Array }));
    if (grids.length === 0) throw new Error('the surface view needs the walkable ring’s heights');
    this.walkGrid = grids[0];
    this.overGrids = grids;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      logarithmicDepthBuffer: true,
      powerPreference: 'high-performance',
    });
    this.pixelRatio = Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.setClearColor(0x000000, 1);
    this.canvas = this.renderer.domElement;
    this.canvas.style.touchAction = 'none';
    this.canvas.style.display = 'block';
    this.canvas.tabIndex = -1;
    container.appendChild(this.canvas);
    this.scene.background = new THREE.Color(0x000000);
    this.camera.rotation.order = 'YXZ';

    data.forEach((d, i) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(d.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(d.normals, 3));
      geometry.setAttribute('sunlit', new THREE.BufferAttribute(new Float32Array(d.size * d.size).fill(1), 1));
      geometry.setIndex(new THREE.BufferAttribute(d.indices, 1));
      geometry.computeBoundingSphere();
      const material = new THREE.ShaderMaterial({
        vertexShader: TERRAIN_VERTEX,
        fragmentShader: TERRAIN_FRAGMENT,
        uniforms: { ...this.uniforms, detail: { value: i <= 1 ? 1 : 0 } },
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = d.name;
      mesh.matrixAutoUpdate = false;
      this.meshes.push(mesh);
      this.scene.add(mesh);
    });

    const disc = spotTexture(64, (r) => (r < 0.92 ? 1 : (1 - r) / 0.08));
    const glare = spotTexture(128, (r) => 0.55 * Math.exp(-r * 5.5) * (1 - r));
    this.textures.push(disc, glare);
    this.sunDisc = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: disc, color: 0xfff6e0, depthWrite: false, toneMapped: false }),
    );
    this.sunGlare = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glare,
        color: 0xffe7b0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        transparent: true,
        toneMapped: false,
      }),
    );
    this.earth = new THREE.Mesh(
      new THREE.SphereGeometry(1, 48, 32),
      new THREE.ShaderMaterial({
        vertexShader: EARTH_VERTEX,
        fragmentShader: EARTH_FRAGMENT,
        uniforms: { sunDir: this.uniforms.sunDir },
      }),
    );
    this.scene.add(this.sunGlare, this.sunDisc, this.earth);

    // The touchdown target: a gold ring laid on the ground and, during the descent, a faint column above it.
    const ground = gridUpAt(this.walkGrid, 0, 0);
    this.touchdownTop = ground + 7;
    const ringShape = new THREE.RingGeometry(4, 6, 64, 2);
    const flat = ringShape.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < flat.count; i++) {
      // The ring's plane (x east, y north) onto the terrain, 20 cm above it.
      const east = flat.getX(i);
      const north = flat.getY(i);
      const h = gridUpAt(this.walkGrid, east, north);
      flat.setXYZ(i, east, (Number.isFinite(h) ? h : ground) + 0.2, -north);
    }
    flat.needsUpdate = true;
    ringShape.computeBoundingSphere();
    this.ring = new THREE.Mesh(
      ringShape,
      new THREE.MeshBasicMaterial({ color: 0xf4b63f, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    );
    this.beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.8, 0.8, 600, 16, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xf4b63f,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.beam.position.y = ground + 300;
    this.touchdown.add(this.ring, this.beam);
    this.scene.add(this.touchdown);

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(container);
    this.fit();
    this.placeAtTouchdown();
    this.start();
  }

  /** The Sun and the Earth at a new moment, and the shadows with them when they have been worked out. */
  setLighting(light: SurfaceLighting): void {
    this.sunDir = light.sunDir;
    this.earthDir = light.earthDir;
    this.sunRadiusDeg = light.sunRadiusDeg;
    this.earthRadiusDeg = light.earthRadiusDeg;
    toThree(light.sunDir, this.uniforms.sunDir.value).normalize();
    const elevDeg = (Math.asin(Math.max(-1, Math.min(1, light.sunDir[2]))) * 180) / Math.PI;
    this.uniforms.sunPower.value = SUN_POWER * exposureFor(elevDeg);
    if (light.sunlit) {
      light.sunlit.forEach((values, i) => {
        const attr = this.meshes[i]?.geometry.getAttribute('sunlit') as THREE.BufferAttribute | undefined;
        if (!attr || attr.array.length !== values.length) return;
        (attr.array as Float32Array).set(values);
        attr.needsUpdate = true;
      });
    }
    this.dirty = true;
  }

  /** Starts the descent from the top, facing `headingRad` at touchdown; with reduced motion, it is a cut. */
  startDescent(headingRad?: number): void {
    this.homeHeading = headingRad ?? this.defaultHeading();
    this.releasePointer();
    if (this.reducedMotion) {
      this.finishDescent();
      return;
    }
    this.descent = {
      plan: { ...DEFAULT_DESCENT, headingRad: this.homeHeading, eyeM: this.eyeM },
      startMs: performance.now(),
    };
    this.beam.visible = true;
    this.setMode('descent');
    this.dirty = true;
  }

  /** Lands at once. */
  skipDescent(): void {
    if (this.mode === 'descent') this.finishDescent();
  }

  /** Back to the touchdown point, facing the way the walk began. */
  resetPosition(): void {
    this.pos = { east: 0, north: 0 };
    this.heading = this.homeHeading;
    this.pitch = 0;
    this.setBlocked(null);
    this.dirty = true;
    this.markMoved(true);
  }

  /** Captures the mouse for looking around; Escape (the browser's own) lets it go. Call from a click. */
  requestPointerLook(): void {
    if (this.mode !== 'explore') return;
    try {
      const asked = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      asked?.catch?.(() => {});
    } catch {
      // A browser without pointer lock still has drag-to-look.
    }
  }

  releasePointer(): void {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  /** The on-screen walk pad: forward and rightward, each −1 to 1, held until set back to 0. */
  setTouchMove(forward: number, right: number): void {
    this.touch = { forward, right };
    if (forward || right) this.dirty = true;
  }

  /** Turns the view from buttons or keys, radians (heading clockwise, pitch up). */
  turnBy(headingRad: number, pitchRad: number): void {
    if (this.mode !== 'explore') return;
    this.heading += headingRad;
    this.pitch = clampPitch(this.pitch + pitchRad);
    this.dirty = true;
  }

  setInspectionLight(on: boolean): void {
    this.uniforms.inspect.value = on ? 1 : 0;
    this.dirty = true;
  }

  setTouchdownMarker(shown: boolean): void {
    this.touchdown.visible = shown;
    this.dirty = true;
  }

  /** The eye's place on the ground now, local metres. */
  position(): { east: number; north: number; headingRad: number } {
    return { ...this.pos, headingRad: this.heading };
  }

  /** The average share of the Sun the walkable ground gets within `radiusM` of a point: how dark it is around you. */
  sunlitAround(east: number, north: number, radiusM: number): number {
    const mesh = this.meshes[0];
    const g = this.walkGrid;
    if (!mesh) return 1;
    const lit = mesh.geometry.getAttribute('sunlit').array as Float32Array;
    const c0 = Math.max(0, Math.floor((east - radiusM + g.halfM) / g.spacingM));
    const c1 = Math.min(g.size - 1, Math.ceil((east + radiusM + g.halfM) / g.spacingM));
    const r0 = Math.max(0, Math.floor((g.halfM - north - radiusM) / g.spacingM));
    const r1 = Math.min(g.size - 1, Math.ceil((g.halfM - north + radiusM) / g.spacingM));
    let sum = 0;
    let n = 0;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const e = -g.halfM + c * g.spacingM;
        const nn = g.halfM - r * g.spacingM;
        if ((e - east) ** 2 + (nn - north) ** 2 > radiusM * radiusM || !Number.isFinite(g.up[r * g.size + c])) continue;
        sum += lit[r * g.size + c];
        n++;
      }
    }
    return n ? sum / n : 1;
  }

  /** For checking: where the camera is against the ground under it, and how much of each ring the Sun reaches. */
  debugState(): {
    mode: SurfaceMode;
    cameraUpM: number;
    groundUpM: number;
    clearanceM: number;
    pixelRatio: number;
    sunlitMean: number[];
  } {
    const groundUpM = this.groundAt(this.camera.position.x, -this.camera.position.z);
    return {
      mode: this.mode,
      cameraUpM: this.camera.position.y,
      groundUpM,
      clearanceM: this.camera.position.y - groundUpM,
      pixelRatio: this.pixelRatio,
      sunlitMean: this.meshes.map((m) => {
        const a = m.geometry.getAttribute('sunlit').array as Float32Array;
        let sum = 0;
        for (const v of a) sum += v;
        return sum / a.length;
      }),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.releasePointer();
    this.resize.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      for (const m of Array.isArray(material) ? material : material ? [material] : []) m.dispose();
    });
    for (const t of this.textures) t.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }

  // --- Internals ---

  private defaultHeading(): number {
    // Face the Earth if it is up, else the Sun, else north.
    const earth = lookAngles(this.earthDir);
    if (earth.pitchRad > (2 * Math.PI) / 180) return earth.headingRad;
    const sun = lookAngles(this.sunDir);
    if (sun.pitchRad > -Math.PI / 180) return sun.headingRad;
    return 0;
  }

  private placeAtTouchdown(): void {
    this.pos = { east: 0, north: 0 };
    this.heading = this.homeHeading;
    this.pitch = 0;
  }

  private finishDescent(): void {
    this.descent = undefined;
    this.descentPoseNow = undefined;
    this.beam.visible = false;
    this.placeAtTouchdown();
    this.setMode('explore');
    this.dirty = true;
    this.markMoved(true);
  }

  private setMode(mode: SurfaceMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.opts.onMode?.(mode);
  }

  private setBlocked(reason: MoveBlock | null): void {
    if (reason) this.blockedAtMs = performance.now();
    if (reason === this.blocked) return;
    this.blocked = reason;
    this.opts.onBlocked?.(reason);
  }

  private markMoved(now = false): void {
    this.movedAtMs = now ? Number.NEGATIVE_INFINITY : performance.now();
    this.settled = false;
  }

  /** The ground's local up under a point, from the finest ring that has it. */
  private groundAt = (east: number, north: number): number => {
    for (const g of this.overGrids) {
      const h = gridUpAt(g, east, north);
      if (Number.isFinite(h)) return h;
    }
    return Number.NaN;
  };

  private fit(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  private start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastMs = performance.now();
    this.frame = requestAnimationFrame(this.loop);
  }

  private stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frame);
  }

  private readonly loop = (now: number): void => {
    if (!this.running) return;
    this.frame = requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, Math.max(0, (now - this.lastMs) / 1000));
    this.lastMs = now;
    let moving = false;
    if (this.mode === 'descent' && this.descent) {
      const k = (now - this.descent.startMs) / (this.descent.plan.durationS * 1000);
      if (k >= 1) this.finishDescent();
      else this.descentPoseNow = descentPose(k, this.descent.plan, this.groundAt);
      moving = true;
    } else if (this.mode === 'explore') {
      moving = this.walk(dt, now);
    }
    if (!this.settled && !moving && now - this.movedAtMs > SETTLE_MS) {
      this.settled = true;
      this.opts.onSettled?.(this.pos.east, this.pos.north);
    }
    if (moving) this.dirty = true;
    if (!this.dirty) return;
    this.dirty = false;
    this.applyCamera();
    this.renderer.render(this.scene, this.camera);
    this.emitLabels();
    if (moving) this.watchSpeed(dt);
  };

  private walk(dt: number, now: number): boolean {
    const k = this.keys;
    const on = (...codes: string[]) => codes.some((c) => k.has(c));
    const forward = Math.max(
      -1,
      Math.min(1, (on('KeyW', 'ArrowUp') ? 1 : 0) - (on('KeyS', 'ArrowDown') ? 1 : 0) + this.touch.forward),
    );
    const right = Math.max(
      -1,
      Math.min(1, (on('KeyD', 'ArrowRight') ? 1 : 0) - (on('KeyA', 'ArrowLeft') ? 1 : 0) + this.touch.right),
    );
    const turn = (on('KeyE') ? 1 : 0) - (on('KeyQ') ? 1 : 0);
    let moved = false;
    if (turn) {
      this.heading += turn * TURN_RAD_PER_S * dt;
      moved = true;
    }
    if (forward || right) {
      const pace = on('ShiftLeft', 'ShiftRight') ? FAST_M_PER_S : WALK_M_PER_S;
      const [de, dn] = walkStep(this.heading, forward, right, pace * dt);
      const step = clampMove(
        this.walkGrid,
        this.pos,
        { east: this.pos.east + de, north: this.pos.north + dn },
        EDGE_MARGIN_M,
      );
      this.pos = { east: step.east, north: step.north };
      this.setBlocked(step.blocked);
      this.markMoved();
      moved = true;
    } else if (this.blocked && now - this.blockedAtMs > 1500) {
      this.setBlocked(null);
    }
    return moved;
  }

  private applyCamera(): void {
    const cam = this.camera;
    if (this.mode === 'descent' && this.descentPoseNow) {
      const p = this.descentPoseNow;
      cam.position.set(p.east, p.up, -p.north);
      cam.lookAt(this.tmp.copy(cam.position).add(toThree(p.look, this.tmp2)));
    } else {
      const ground = gridUpAt(this.walkGrid, this.pos.east, this.pos.north);
      cam.position.set(this.pos.east, (Number.isFinite(ground) ? ground : 0) + this.eyeM, -this.pos.north);
      cam.rotation.set(this.pitch, -this.heading, 0, 'YXZ');
    }
    cam.updateMatrixWorld();
    // Standing on the target, its ring would fill the view: it fades in only once you walk away from it.
    const away = Math.hypot(cam.position.x, cam.position.z);
    this.ring.material.opacity = this.mode === 'descent' ? 0.9 : 0.85 * Math.min(1, Math.max(0, (away - 8) / 25));
    // The Sun and the Earth keep their directions wherever the eye goes: they travel with it, far out.
    const sunAt = toThree(this.sunDir, this.tmp).normalize();
    const sunSize = 2 * SKY_M * Math.tan((this.sunRadiusDeg * Math.PI) / 180);
    this.sunDisc.position.copy(cam.position).addScaledVector(sunAt, SKY_M);
    this.sunDisc.scale.setScalar(sunSize);
    this.sunGlare.position.copy(this.sunDisc.position);
    this.sunGlare.scale.setScalar(sunSize * 14);
    const earthAt = toThree(this.earthDir, this.tmp2).normalize();
    this.earth.position.copy(cam.position).addScaledVector(earthAt, SKY_M);
    this.earth.scale.setScalar(SKY_M * Math.tan((this.earthRadiusDeg * Math.PI) / 180));
  }

  private emitLabels(): void {
    const report = this.opts.onLabels;
    if (!report) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.getWorldDirection(this.forward);
    const place = (key: SurfaceLabelKey, at: THREE.Vector3) => {
      const label = this.labels[key];
      const ahead = this.tmp2.copy(at).sub(this.camera.position).dot(this.forward) > 0;
      at.project(this.camera);
      label.shown = ahead && Math.abs(at.x) <= 1.05 && Math.abs(at.y) <= 1.05;
      label.x = ((at.x + 1) / 2) * w;
      label.y = ((1 - at.y) / 2) * h;
    };
    const along = (dir: THREE.Vector3) => this.tmp.copy(this.camera.position).addScaledVector(dir, 1000);
    place('sun', along(toThree(this.sunDir, this.labelDir).normalize()));
    place('earth', along(toThree(this.earthDir, this.labelDir).normalize()));
    for (const [key, dir] of COMPASS) place(key, along(dir));
    this.tmp.set(0, this.touchdownTop, 0);
    place('touchdown', this.tmp);
    this.labels.touchdown.shown &&= this.touchdown.visible;
    report(this.labels);
  }

  /** On a machine that cannot keep up while moving, fewer pixels: down to three quarters of one per CSS pixel. */
  private watchSpeed(dt: number): void {
    this.sampledFrames++;
    if (dt > 0.045) this.slowFrames++;
    if (this.sampledFrames < 90) return;
    if (this.slowFrames > 45 && this.pixelRatio > 0.75) {
      this.pixelRatio = Math.max(0.75, this.pixelRatio - 0.25);
      this.renderer.setPixelRatio(this.pixelRatio);
      this.fit();
    }
    this.sampledFrames = 0;
    this.slowFrames = 0;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    const walkKeys = [
      'KeyW',
      'KeyA',
      'KeyS',
      'KeyD',
      'KeyQ',
      'KeyE',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
    ];
    if (this.mode !== 'explore' || !(walkKeys.includes(e.code) || e.code.startsWith('Shift'))) return;
    // Arrow keys on a focused button would otherwise move focus or scroll; in the view they walk.
    if (e.code.startsWith('Arrow')) e.preventDefault();
    this.keys.add(e.code);
    this.dirty = true;
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  /** Losing focus must not leave a key held down, walking on by itself. */
  private readonly onBlur = (): void => {
    this.keys.clear();
    this.touch = { forward: 0, right: 0 };
    this.drag = undefined;
  };

  private readonly onVisibility = (): void => {
    if (document.hidden) {
      this.onBlur();
      this.stop();
    } else {
      this.start();
      this.dirty = true;
    }
  };

  private readonly onPointerLockChange = (): void => {
    const locked = document.pointerLockElement === this.canvas;
    if (!locked) this.keys.clear();
    this.opts.onPointerLock?.(locked);
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (document.pointerLockElement !== this.canvas || this.mode !== 'explore') return;
    this.heading += e.movementX * LOOK_RAD_PER_PX;
    this.pitch = clampPitch(this.pitch - e.movementY * LOOK_RAD_PER_PX);
    this.dirty = true;
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (this.mode !== 'explore' || document.pointerLockElement === this.canvas) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, touch: e.pointerType !== 'mouse' };
    this.canvas.setPointerCapture(e.pointerId);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    const dx = e.clientX - this.drag.x;
    const dy = e.clientY - this.drag.y;
    this.drag.x = e.clientX;
    this.drag.y = e.clientY;
    // Dragging the view turns it the way a hand would push the scene: drag left to look right.
    const k = this.drag.touch ? DRAG_RAD_PER_PX : LOOK_RAD_PER_PX;
    this.heading -= dx * k;
    this.pitch = clampPitch(this.pitch + dy * k);
    this.dirty = true;
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.drag = undefined;
  };

  private readonly onContextLost = (e: Event): void => {
    e.preventDefault();
    this.stop();
    if (!this.disposed) this.opts.onLost?.();
  };
}
