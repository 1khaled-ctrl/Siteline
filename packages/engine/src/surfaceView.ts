import { clampMove, EYE_HEIGHT_M, gridUpAt, type LocalGrid, type MoveBlock, northTurnDeg } from '@siteline/physics';
import * as THREE from 'three';
import {
  clampPitch,
  DEFAULT_DESCENT,
  type DescentPlan,
  descentPose,
  edgePointer,
  headingDegOf,
  lookAngles,
  type PointerBand,
  type Pose,
  relativeDeg,
  walkStep,
  wrapDeg,
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
  /** 0 is the walkable ground; each ring after it has cells twice the size and reaches twice as far. */
  index: number;
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
  /**
   * The same over the walkable square at a finer spacing than its mesh, as bytes 0 to 255 laid out like a grid (row 0
   * north): where it reaches, the ground's shadows are read from it, so their edges are as sharp as its cells.
   */
  shadowMap?: { data: Uint8Array; size: number; halfM: number };
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

/**
 * Which way the view faces and where things lie from there, for the compass: after every frame that moved the view.
 * The same object each time, updated in place.
 */
export interface SurfaceHeading {
  /** Degrees clockwise from local north where the eye is, 0 to 360 (at the pole, north is the 0° meridian). */
  headingDeg: number;
  /** Where the Sun, the Earth and the touchdown point lie from that heading: degrees, −180 to 180, clockwise positive. */
  sunRelDeg: number;
  earthRelDeg: number;
  touchdownRelDeg: number;
  /** How far the eye is from the touchdown point along the ground, metres. */
  fromTouchdownM: number;
}

/** A pointer at the screen's edge toward a body that is out of view (CSS pixels in the container). */
export interface EdgePointerPoint {
  x: number;
  y: number;
  /** Which way it points on the screen, radians from rightward, clockwise. */
  angleRad: number;
  /** The body is out of view, so the pointer is wanted. */
  shown: boolean;
}

export type SurfacePointers = Record<'sun' | 'earth', EdgePointerPoint>;

export interface SurfaceViewOptions {
  reducedMotion?: boolean;
  eyeHeightM?: number;
  /** The ring you walk on (by its index): 0, or 1 when a finer ring lies inside it. */
  walkIndex?: number;
  onMode?: (mode: SurfaceMode) => void;
  /** Why the last step was refused (the edge of the terrain, a hole in it), and null once walking freely again. */
  onBlocked?: (reason: MoveBlock | null) => void;
  onPointerLock?: (locked: boolean) => void;
  /** Where the eye came to rest after moving: local east and north, metres. */
  onSettled?: (east: number, north: number) => void;
  /** Screen positions of the labels, after every frame that moved them (CSS pixels in the container). */
  onLabels?: (labels: SurfaceLabels) => void;
  /** The landing point, so the compass and the letters on the horizon follow local north as it turns near the pole. */
  site?: { latDeg: number; groundHeightM: number };
  /** Which way the view faces and where things lie from there, for the compass, after every frame that moved it. */
  onHeading?: (heading: SurfaceHeading) => void;
  /** Pointers at the screen's edge toward the Sun and the Earth while they are out of view, after every moving frame. */
  onPointers?: (pointers: SurfacePointers) => void;
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

/** The compass points on the horizon, a quarter turn apart clockwise from north. */
const COMPASS_KEYS = ['north', 'east', 'south', 'west'] as const;

/** Until told where the panels are, pointers keep to the middle of the screen's height, 28 px in from the sides. */
const middleBand = (h: number): PointerBand => ({ sidePx: 28, topPx: 0.32 * h, bottomPx: 0.62 * h });

/** Which way a camera looks along the ground: degrees clockwise from the scene's north (three.js −z), 0 to 360. */
export function cameraHeadingDeg(camera: THREE.Camera, out = new THREE.Vector3()): number {
  camera.getWorldDirection(out);
  return headingDegOf(out.x, -out.z);
}

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
uniform sampler2D shadowMap;
uniform float shadowHalf;
uniform float shadowSize;
uniform float useShadowMap;
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
  // The cast shadows: from the fine shadow map where it covers the ground, else from the mesh's own nodes.
  float lit = vSunlit;
  if (useShadowMap > 0.5 && abs(vWorld.x) < shadowHalf && abs(vWorld.z) < shadowHalf) {
    vec2 uv = (vWorld.xz + shadowHalf) / (2.0 * shadowHalf) * ((shadowSize - 1.0) / shadowSize) + 0.5 / shadowSize;
    lit = texture2D(shadowMap, uv).r;
  }
  vec3 base = albedo * grain;
  vec3 colour = base * sunPower * ls * lit;
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

/** A ring's geometry: its nodes, normals, the share of the Sun each node sees, and its triangles. */
function ringGeometry(d: SurfaceMeshData, sunlit: Float32Array): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(d.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(d.normals, 3));
  geometry.setAttribute('sunlit', new THREE.BufferAttribute(sunlit, 1));
  geometry.setIndex(new THREE.BufferAttribute(d.indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

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
    shadowMap: { value: SurfaceView.blankShadow() },
    shadowHalf: { value: 0 },
    shadowSize: { value: 1 },
    useShadowMap: { value: 0 },
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
  /** The camera's heading from the touchdown point's north, and how far local north has turned where the eye is. */
  private sceneHeadingDeg = 0;
  private northTurn = 0;
  /** The Sun's and the Earth's headings from the touchdown point's north. */
  private sunAzDeg = 0;
  private earthAzDeg = 0;
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
  private readonly facing: SurfaceHeading = {
    headingDeg: 0,
    sunRelDeg: 0,
    earthRelDeg: 0,
    touchdownRelDeg: 0,
    fromTouchdownM: 0,
  };
  private readonly pointers: SurfacePointers = {
    sun: { x: 0, y: 0, angleRad: 0, shown: false },
    earth: { x: 0, y: 0, angleRad: 0, shown: false },
  };
  private readonly camDir = new THREE.Vector3();
  private pointerBand: PointerBand | null = null;
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
    const withHeights = data.filter((d) => d.up);
    const grids = withHeights.map(
      (d): LocalGrid => ({ size: d.size, spacingM: d.spacingM, halfM: d.halfM, up: d.up as Float32Array }),
    );
    const walk = withHeights.findIndex((d) => d.index === (opts.walkIndex ?? 0));
    if (walk < 0) throw new Error('the surface view needs the walkable ring’s heights');
    this.walkGrid = grids[walk];
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

    for (const d of data) {
      const geometry = ringGeometry(d, new Float32Array(d.size * d.size).fill(1));
      const material = new THREE.ShaderMaterial({
        vertexShader: TERRAIN_VERTEX,
        fragmentShader: TERRAIN_FRAGMENT,
        uniforms: { ...this.uniforms, detail: { value: d.index <= 1 ? 1 : 0 } },
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `ring ${d.index}`;
      mesh.matrixAutoUpdate = false;
      this.meshes.push(mesh);
      this.scene.add(mesh);
    }

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
    const ground = this.groundAt(0, 0);
    this.touchdownTop = ground + 7;
    const ringShape = new THREE.RingGeometry(4, 6, 64, 2);
    const flat = ringShape.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < flat.count; i++) {
      // The ring's plane (x east, y north) onto the terrain, 20 cm above it.
      const east = flat.getX(i);
      const north = flat.getY(i);
      const h = this.groundAt(east, north);
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
    this.sunAzDeg = headingDegOf(light.sunDir[0], light.sunDir[1]);
    this.earthAzDeg = headingDegOf(light.earthDir[0], light.earthDir[1]);
    this.sunRadiusDeg = light.sunRadiusDeg;
    this.earthRadiusDeg = light.earthRadiusDeg;
    toThree(light.sunDir, this.uniforms.sunDir.value).normalize();
    const elevDeg = (Math.asin(Math.max(-1, Math.min(1, light.sunDir[2]))) * 180) / Math.PI;
    this.uniforms.sunPower.value = SUN_POWER * exposureFor(elevDeg);
    if (light.shadowMap) this.setShadowMap(light.shadowMap);
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

  /**
   * Swaps in a ring rebuilt from its own detailed read for the coarse stand-in it was drawn from: a new geometry, the
   * old one freed. Its shadows stay as they were until the light is worked out again.
   */
  updateRing(d: SurfaceMeshData): void {
    const mesh = this.meshes[d.index];
    if (!mesh) return;
    const old = mesh.geometry;
    const sunlit = (old.getAttribute('sunlit').array as Float32Array).slice();
    mesh.geometry = ringGeometry(
      d,
      sunlit.length === d.size * d.size ? sunlit : new Float32Array(d.size * d.size).fill(1),
    );
    old.dispose();
    if (d.up) {
      const grid = this.overGrids.find((g) => g.spacingM === d.spacingM && g.halfM === d.halfM);
      if (grid) grid.up = d.up;
    }
    this.dirty = true;
  }

  /** A 1 × 1 texture standing in until the first shadow map arrives (a sampler must always have one). */
  private static blankShadow(): THREE.DataTexture {
    const t = new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
    t.needsUpdate = true;
    return t;
  }

  /** The walkable ground's fine shadow map, as a single-channel texture read with linear filtering. */
  private setShadowMap(map: { data: Uint8Array; size: number; halfM: number }): void {
    const current = this.uniforms.shadowMap.value;
    if (current.image.width === map.size && current.image.height === map.size) {
      (current.image.data as Uint8Array).set(map.data);
      current.needsUpdate = true;
    } else {
      const texture = new THREE.DataTexture(
        map.data.slice(),
        map.size,
        map.size,
        THREE.RedFormat,
        THREE.UnsignedByteType,
      );
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearFilter;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      // Rows of an odd number of bytes: tell WebGL they are packed tight.
      texture.unpackAlignment = 1;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      this.uniforms.shadowMap.value = texture;
      current.dispose();
    }
    this.uniforms.shadowHalf.value = map.halfM;
    this.uniforms.shadowSize.value = map.size;
    this.uniforms.useShadowMap.value = 1;
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

  /** Draws the next frame even if nothing moved, so the labels, pointers and compass report where they are again. */
  redraw(): void {
    this.dirty = true;
  }

  /**
   * Where pointers toward the Sun and the Earth may sit, CSS pixels in the container: the open view between the panels
   * at the top and the bottom. Null puts them back in the middle of the screen's height.
   */
  setPointerBand(band: PointerBand | null): void {
    this.pointerBand = band;
    this.dirty = true;
  }

  /** The eye's place on the ground now, local metres. */
  position(): { east: number; north: number; headingRad: number } {
    return { ...this.pos, headingRad: this.heading };
  }

  /** The average share of the Sun the walkable ground gets within `radiusM` of a point: how dark it is around you. */
  sunlitAround(east: number, north: number, radiusM: number): number {
    const mesh = this.meshes[this.opts.walkIndex ?? 0];
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
    headingDeg: number;
    northTurnDeg: number;
    facing: SurfaceHeading;
  } {
    const groundUpM = this.groundAt(this.camera.position.x, -this.camera.position.z);
    return {
      mode: this.mode,
      cameraUpM: this.camera.position.y,
      groundUpM,
      clearanceM: this.camera.position.y - groundUpM,
      pixelRatio: this.pixelRatio,
      headingDeg: this.facing.headingDeg,
      northTurnDeg: this.northTurn,
      facing: { ...this.facing },
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
    this.uniforms.shadowMap.value.dispose();
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
    this.report();
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
      // The ground you see is the finest ring's, which can lie inside the one you walk on (the 5 m inside the 10 m).
      const ground = this.groundAt(this.pos.east, this.pos.north);
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

  /** After a frame that moved the view: which way it faces, for the compass, and where its labels and pointers go. */
  private report(): void {
    const cam = this.camera;
    const heading = cameraHeadingDeg(cam, this.forward);
    // Straight up or down has no heading, so the last one stays; the pitch limit and the descent never quite get there.
    if (Math.hypot(this.forward.x, this.forward.z) > 1e-6) this.sceneHeadingDeg = heading;
    const east = cam.position.x;
    const north = -cam.position.z;
    this.northTurn = this.opts.site ? northTurnDeg(this.opts.site, east, north) : 0;
    const facing = this.facing;
    facing.headingDeg = wrapDeg(this.sceneHeadingDeg - this.northTurn);
    // Where things lie from the view doesn't depend on which north it is measured from.
    facing.sunRelDeg = relativeDeg(this.sunAzDeg, this.sceneHeadingDeg);
    facing.earthRelDeg = relativeDeg(this.earthAzDeg, this.sceneHeadingDeg);
    facing.touchdownRelDeg = relativeDeg(headingDegOf(-east, -north), this.sceneHeadingDeg);
    facing.fromTouchdownM = Math.hypot(east, north);
    this.opts.onHeading?.(facing);
    this.emitLabels();
  }

  private emitLabels(): void {
    const report = this.opts.onLabels;
    const reportPointers = this.opts.onPointers;
    if (!report && !reportPointers) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
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
    // North, east, south and west as they are where the eye is (near the pole, north turns as you walk), just under the
    // level line where the horizon is.
    COMPASS_KEYS.forEach((key, k) => {
      const az = ((k * 90 + this.northTurn) * Math.PI) / 180;
      place(key, along(this.labelDir.set(Math.sin(az), -0.004, -Math.cos(az)).normalize()));
    });
    this.tmp.set(0, this.touchdownTop, 0);
    place('touchdown', this.tmp);
    this.labels.touchdown.shown &&= this.touchdown.visible;
    report?.(this.labels);
    if (reportPointers) {
      this.point('sun', this.sunDir, w, h);
      this.point('earth', this.earthDir, w, h);
      reportPointers(this.pointers);
    }
  }

  /** The pointer toward the Sun or the Earth: wanted only while its label is not on screen. */
  private point(key: 'sun' | 'earth', dir: V3, w: number, h: number): void {
    const cam = this.camera;
    const pointer = this.pointers[key];
    // The direction in the camera's own frame: x right, y up, looking along −z.
    const v = toThree(dir, this.camDir).normalize().transformDirection(cam.matrixWorldInverse);
    const tanHalfY = Math.tan((cam.fov * Math.PI) / 360);
    const at = this.labels[key].shown
      ? null
      : edgePointer(
          [v.x, v.y, v.z],
          { width: w, height: h, tanHalfX: tanHalfY * cam.aspect, tanHalfY },
          this.pointerBand ?? middleBand(h),
        );
    pointer.shown = at !== null;
    if (at) {
      pointer.x = at.x;
      pointer.y = at.y;
      pointer.angleRad = at.angleRad;
    }
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
