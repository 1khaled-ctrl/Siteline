import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { lonLatToScene, sceneToLonLat } from './earthData';
import type { SurfaceLine } from './landerData';
import {
  decodeHeights,
  featureAt,
  type HeightGrid,
  heightAtM,
  labelStyleOf,
  MARS_RADIUS_KM,
  type MarsFeature,
  type MarsNamesJson,
  parseMarsFeatures,
} from './marsData';
import { discToScreen, fitCamera, type Insets, NO_INSETS, type ScreenDisc } from './screen';

export interface MarsAssets {
  /** Optional small colour map shown while the full one loads. */
  preview?: string;
  color: string;
  /** East and north slopes in red and green, as on the Moon globe. */
  normal: string;
  /** Elevation in metres as a 16-bit number in red and green (see `decodeHeights`). */
  height: string;
  /** The Mars names file (`MarsNamesJson`) built from the IAU Gazetteer. */
  names: string;
}

export interface MarsPlace {
  latDeg: number;
  lonDeg: number;
  /** Metres above the areoid, once the height map has loaded. */
  elevationM?: number;
  feature?: MarsFeature;
  featureDistKm?: number;
  /** True when the point is within the feature's diameter, false when it is only near its centre. */
  inside?: boolean;
}

export interface MarsViewOptions {
  assets: MarsAssets;
  onPick?: (place: MarsPlace) => void;
  /** Called once the names have loaded, with every feature, largest first. */
  onFeatures?: (features: readonly MarsFeature[]) => void;
  /** Called once the height map has loaded, so elevations can be read. */
  onHeights?: () => void;
}

const ACCENT = 0x5aa9ff;
const HOME = { latDeg: 5, lonDeg: -60, distance: 3.4 };
// Olympus Mons is the highest ground, 21.2 km above the areoid.
const RELIEF_MAX_KM = 21.5;
const FONT = '"IBM Plex Sans", system-ui, sans-serif';
const LABEL_POOL = 90;
/** How far above the ground the lander pins and the drawn routes sit. */
const PIN_LIFT_M = 40;
const ROUTE_LIFT_M = 140;
const ROUTE_DOT_LIFT_M = 170;

const VERTEX = `varying vec2 vUv; varying vec3 vP; varying vec3 vV;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vP = wp.xyz; vV = cameraPosition - wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

// Shading from the concept demo: slopes from the normal map tilt the surface, a headlight (or the real Sun) lights it,
// and a dusty haze glows at the limb.
const FRAGMENT = `uniform sampler2D map; uniform sampler2D slopes; uniform float hasSlopes; uniform float relief;
uniform vec3 sunDir; uniform vec3 camLight; uniform float realLight;
varying vec2 vUv; varying vec3 vP; varying vec3 vV;
void main() {
  vec3 n0 = normalize(vP);
  vec3 c = cross(vec3(0.0, 1.0, 0.0), n0); float cl = length(c);
  vec3 east = cl > 1e-5 ? c / cl : vec3(0.0, 0.0, -1.0); vec3 north = cross(n0, east);
  vec3 n = n0;
  if (hasSlopes > 0.5) {
    vec2 s = texture2D(slopes, vUv).rg * 2.0 - 1.0;
    vec2 nxy = sign(s) * s * s; float nz = sqrt(max(0.0, 1.0 - dot(nxy, nxy)));
    n = normalize((east * nxy.x + north * nxy.y) * relief + n0 * nz);
  }
  vec3 albedo = texture2D(map, vUv).rgb; vec3 V = normalize(vV); float I;
  float day = 1.0;
  if (realLight > 0.5) {
    vec3 L = normalize(sunDir); float m0 = max(dot(n, L), 0.0);
    I = 1.08 * pow(m0, 0.9);
    I = I * smoothstep(-0.045, 0.03, dot(n0, L)) + 0.016;
    day = smoothstep(-0.2, 0.3, dot(n0, L));
  } else {
    I = 0.17 + 0.98 * max(dot(n, normalize(camLight)), 0.0);
  }
  vec3 col = albedo * I;
  float haze = pow(1.0 - max(dot(n0, V), 0.0), 3.0);
  col += vec3(0.80, 0.52, 0.36) * haze * 0.3 * day;
  gl_FragColor = vec4(col, 1.0);
}`;

const GLOW_VERTEX = `varying vec3 vN; varying vec3 vV;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const GLOW_FRAGMENT = `uniform vec3 glow; varying vec3 vN; varying vec3 vV;
void main() { float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 4.5); gl_FragColor = vec4(glow, f * 0.6); }`;

const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const dirOf = (latDeg: number, lonDeg: number) => new THREE.Vector3(...lonLatToScene(latDeg, lonDeg));

interface Label {
  el: HTMLElement;
}

/** A relief globe of Mars: MOLA heights on the mesh, shaded by slope, with IAU feature names. One scene unit is one Mars radius. */
export class MarsView {
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 0.0004, 50);
  private readonly controls: OrbitControls;
  private readonly material: THREE.ShaderMaterial;
  private readonly glowMaterial: THREE.ShaderMaterial;
  private readonly globe: THREE.Mesh;
  private readonly baseDirs: Float32Array;
  private readonly marker = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 12),
    new THREE.MeshBasicMaterial({ color: ACCENT, depthTest: false }),
  );
  private readonly labelLayer = document.createElement('div');
  private readonly pool: Label[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly resize: ResizeObserver;
  private readonly textures: THREE.Texture[] = [];
  private readonly ranks: Partial<Record<'map' | 'slopes', number>> = {};
  /** Settles once a colour map is on Mars; fails only when every colour map failed to load. */
  readonly ready: Promise<void>;
  private readonly tmp = { camera: new THREE.Vector3(), p: new THREE.Vector3(), light: new THREE.Vector3() };
  private features: MarsFeature[] = [];
  private featureDirs: THREE.Vector3[] = [];
  private grid?: HeightGrid;
  private exag = 3;
  private showNames = true;
  private selected?: MarsFeature;
  private placed?: { latDeg: number; lonDeg: number };
  private flightId = 0;
  private frameListener?: () => void;
  private routes: readonly SurfaceLine[] = [];
  private routeObjects: (THREE.Line | THREE.Points)[] = [];
  /** Where the flight in progress ends, so a zoom during it builds on the destination, not the half-way point. */
  private destination?: { latDeg: number; lonDeg: number; distance: number };
  private down?: { x: number; y: number };
  private flying = false;
  private frame = 0;
  private disposed = false;

  private insets: Insets = NO_INSETS;
  private readonly frameListeners = new Set<() => void>();

  constructor(
    private readonly container: HTMLElement,
    private readonly opts: MarsViewOptions,
  ) {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        map: { value: null },
        slopes: { value: null },
        hasSlopes: { value: 0 },
        relief: { value: this.exag },
        sunDir: { value: new THREE.Vector3(1, 0, 0) },
        camLight: { value: new THREE.Vector3(0, 0, 1) },
        realLight: { value: 0 },
      },
    });
    const geometry = new THREE.SphereGeometry(1, 512, 256);
    this.baseDirs = Float32Array.from(geometry.attributes.position.array);
    this.globe = new THREE.Mesh(geometry, this.material);
    this.globe.frustumCulled = false;
    this.glowMaterial = new THREE.ShaderMaterial({
      uniforms: { glow: { value: new THREE.Color(0.85, 0.55, 0.38) } },
      vertexShader: GLOW_VERTEX,
      fragmentShader: GLOW_FRAGMENT,
      side: THREE.BackSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const glow = new THREE.Mesh(new THREE.SphereGeometry(1.04, 96, 48), this.glowMaterial);
    this.marker.visible = false;
    this.marker.renderOrder = 10;
    this.scene.add(this.globe, glow, this.marker);

    this.camera.position.copy(dirOf(HOME.latDeg, HOME.lonDeg).multiplyScalar(HOME.distance));
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enablePan = false;
    this.controls.minDistance = this.minDistance();
    this.controls.maxDistance = 8;
    this.controls.addEventListener('change', () => this.requestRender());

    Object.assign(this.labelLayer.style, {
      position: 'absolute',
      inset: '0',
      overflow: 'hidden',
      pointerEvents: 'none',
    });
    container.appendChild(this.labelLayer);
    for (let i = 0; i < LABEL_POOL; i++) this.pool.push(this.makeLabel());

    const maps = [this.loadTexture(opts.assets.color, 'map', 1)];
    if (opts.assets.preview) maps.push(this.loadTexture(opts.assets.preview, 'map', 0));
    this.loadTexture(opts.assets.normal, 'slopes', 1).catch(() => {});
    this.ready = Promise.any(maps);
    void this.loadHeights(opts.assets.height);
    void this.loadNames(opts.assets.names);

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(container);
    this.fit();
  }

  /** Every named feature, largest first; for a search box. */
  allFeatures(): readonly MarsFeature[] {
    return this.features;
  }

  /** What is at a point: the feature, if any, and the elevation once the height map has loaded. */
  describe(latDeg: number, lonDeg: number): MarsPlace {
    const found = featureAt(this.features, latDeg, lonDeg);
    return {
      latDeg,
      lonDeg,
      elevationM: this.grid ? heightAtM(this.grid, latDeg, lonDeg) : undefined,
      feature: found?.feature,
      featureDistKm: found?.distKm,
      inside: found?.inside,
    };
  }

  /** Light the globe with the real Sun (see `setSubsolar`) instead of a light that follows the camera. */
  setRealLight(on: boolean): void {
    this.material.uniforms.realLight.value = on ? 1 : 0;
    this.requestRender();
  }

  /** Where the Sun is overhead; only matters while real light is on. */
  setSubsolar(latDeg: number, lonDeg: number): void {
    (this.material.uniforms.sunDir.value as THREE.Vector3).copy(dirOf(latDeg, lonDeg));
    this.requestRender();
  }

  /** Stretch the heights (and the slope shading) by this factor; 1 is true to scale. */
  setRelief(exaggeration: number): void {
    this.exag = exaggeration;
    this.material.uniforms.relief.value = exaggeration;
    this.controls.minDistance = this.minDistance();
    this.applyRelief();
  }

  setNames(on: boolean): void {
    this.showNames = on;
    this.requestRender();
  }

  /** Mark a place, or clear the mark. The feature's name stays on screen while it is selected. */
  setPlace(place: { latDeg: number; lonDeg: number; feature?: MarsFeature } | undefined): void {
    this.placed = place;
    this.selected = place?.feature;
    this.marker.visible = !!place;
    this.placeMarker();
    this.requestRender();
  }

  /** Swing the camera over a point at `distance` Mars radii from the centre. */
  flyTo(latDeg: number, lonDeg: number, distance: number, durationMs = 1400): Promise<void> {
    const from = this.camera.position.clone();
    const to = dirOf(latDeg, lonDeg);
    const turn = new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(), to);
    const still = new THREE.Quaternion();
    const q = new THREE.Quaternion();
    const d0 = from.length();
    const d1 = clamp(distance, this.controls.minDistance, this.controls.maxDistance);
    const flight = ++this.flightId;
    this.destination = { latDeg, lonDeg, distance: d1 };
    cancelAnimationFrame(this.frame);
    this.flying = true;
    this.controls.enabled = false;
    return new Promise((resolve) => {
      const t0 = performance.now();
      const step = () => {
        if (this.disposed || flight !== this.flightId) return resolve();
        const k = durationMs <= 0 ? 1 : Math.min(1, (performance.now() - t0) / durationMs);
        const e = easeInOut(k);
        q.slerpQuaternions(still, turn, e);
        this.camera.position
          .copy(from)
          .normalize()
          .applyQuaternion(q)
          .multiplyScalar(d0 + (d1 - d0) * e);
        this.camera.lookAt(0, 0, 0);
        this.draw();
        if (k < 1) this.frame = requestAnimationFrame(step);
        else {
          this.frame = 0;
          this.flying = false;
          this.destination = undefined;
          this.controls.enabled = true;
          this.controls.update();
          resolve();
        }
      };
      this.frame = requestAnimationFrame(step);
    });
  }

  /**
   * Frame a whole feature; bigger features get a farther camera. The map is about 2.6 km a pixel, so a small crater
   * is framed from 270 km up rather than from where it would only show blur; zoom in by hand to go lower.
   */
  flyToFeature(f: MarsFeature, durationMs = 1400): Promise<void> {
    return this.flyTo(f.latDeg, f.lonDeg, 1 + clamp((1.6 * f.diameterKm) / MARS_RADIUS_KM, 0.08, 1.8), durationMs);
  }

  flyHome(durationMs = 1400): Promise<void> {
    return this.flyTo(HOME.latDeg, HOME.lonDeg, HOME.distance, durationMs);
  }

  /** Scale the camera's height above the surface (factor < 1 closes in), keeping its direction. */
  zoomBy(factor: number, durationMs = 300): Promise<void> {
    const at = this.destination ?? {
      ...sceneToLonLat(this.camera.position.x, this.camera.position.y, this.camera.position.z),
      distance: this.camera.position.length(),
    };
    return this.flyTo(at.latDeg, at.lonDeg, 1 + (at.distance - 1) * factor, durationMs);
  }

  /** Called after every draw, so overlays such as the lander pins can follow the camera. */
  setFrameListener(listener: (() => void) | undefined): void {
    this.frameListener = listener;
  }

  /** Where a place is in the view, in pixels; undefined when it is on the far side of Mars. */
  project(latDeg: number, lonDeg: number): { xPx: number; yPx: number } | undefined {
    const D = this.camera.position.length();
    const dir = dirOf(latDeg, lonDeg);
    // On the near side when within the horizon angle of the camera's direction, plus a margin.
    if (dir.dot(this.camera.position.clone().normalize()) < 1 / D + 0.01) return undefined;
    this.camera.updateMatrixWorld();
    const p = dir.multiplyScalar(this.radiusAt(latDeg, lonDeg, PIN_LIFT_M)).project(this.camera);
    if (p.z > 1) return undefined;
    const { clientWidth: w, clientHeight: h } = this.container;
    return { xPx: (p.x * 0.5 + 0.5) * w, yPx: (-p.y * 0.5 + 0.5) * h };
  }

  /** True when the camera is close enough that every lander can carry a name. */
  isClose(): boolean {
    return this.camera.position.length() < 2.2;
  }

  /** Draw rover routes and helicopter flights on the ground, lifted a little so the relief does not hide them. */
  setRoutes(lines: readonly SurfaceLine[]): void {
    this.routes = lines;
    this.buildRoutes();
    this.requestRender();
  }

  /** Calls `listener` after every draw, for overlays that must move with the picture; returns a function that stops it. */
  addFrameListener(listener: () => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  /** The globe's outline on the page; null when the camera is inside it. */
  discOnScreen(): ScreenDisc | null {
    return discToScreen(1, this.camera, this.renderer.domElement, new THREE.Vector3());
  }

  /** How much of the canvas the app's panels cover; the view centres itself in the rest. */
  setInsets(insets: Insets): void {
    this.insets = insets;
    this.fit();
  }

  dispose(): void {
    this.disposed = true;
    this.clearRoutes();
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.controls.dispose();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    for (const t of this.textures) t.dispose();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.renderer.dispose();
    canvas.remove();
    this.labelLayer.remove();
  }

  /** Radius of a point `liftM` metres above the surface, in Mars radii, with the heights stretched. */
  private radiusAt(latDeg: number, lonDeg: number, liftM: number): number {
    const heightM = this.grid ? heightAtM(this.grid, latDeg, lonDeg) : 0;
    return 1 + ((heightM + liftM) * this.exag) / (1000 * MARS_RADIUS_KM);
  }

  private clearRoutes(): void {
    for (const o of this.routeObjects) {
      this.scene.remove(o);
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
    this.routeObjects = [];
  }

  private buildRoutes(): void {
    this.clearRoutes();
    for (const line of this.routes) {
      const lift = line.dots ? ROUTE_DOT_LIFT_M : ROUTE_LIFT_M;
      const points = line.points.map(([lat, lon]) => dirOf(lat, lon).multiplyScalar(this.radiusAt(lat, lon, lift)));
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const object = line.dots
        ? new THREE.Points(
            geometry,
            new THREE.PointsMaterial({ color: line.colourHex, size: 4, sizeAttenuation: false }),
          )
        : new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: line.colourHex }));
      object.frustumCulled = false;
      object.renderOrder = 4;
      this.scene.add(object);
      this.routeObjects.push(object);
    }
  }

  /** The closest the camera may come: above the highest peak at the current exaggeration. */
  private minDistance(): number {
    return 1 + (RELIEF_MAX_KM * this.exag) / MARS_RADIUS_KM + 0.004;
  }

  /** Radius of the surface at a point, in Mars radii, with the heights stretched. */
  private surfaceRadius(latDeg: number, lonDeg: number): number {
    return 1 + (this.grid ? (heightAtM(this.grid, latDeg, lonDeg) * this.exag) / (1000 * MARS_RADIUS_KM) : 0);
  }

  /** Push every vertex out (or in) by its height. The sphere's UVs are the grid's: u from −180° to 180°, v from 90° to −90°. */
  private applyRelief(): void {
    const grid = this.grid;
    if (!grid) return;
    const pos = this.globe.geometry.attributes.position;
    const uv = this.globe.geometry.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const r = this.surfaceRadius(uv.getY(i) * 180 - 90, uv.getX(i) * 360 - 180);
      pos.setXYZ(i, this.baseDirs[i * 3] * r, this.baseDirs[i * 3 + 1] * r, this.baseDirs[i * 3 + 2] * r);
    }
    pos.needsUpdate = true;
    this.globe.geometry.computeBoundingSphere();
    this.placeMarker();
    this.buildRoutes();
    this.requestRender();
  }

  private placeMarker(): void {
    if (this.placed)
      this.marker.position.copy(
        dirOf(this.placed.latDeg, this.placed.lonDeg).multiplyScalar(
          this.surfaceRadius(this.placed.latDeg, this.placed.lonDeg),
        ),
      );
  }

  /** Higher `rank` wins, so a small preview never replaces a high-resolution map that arrived first. */
  private loadTexture(url: string, uniform: 'map' | 'slopes', rank: number): Promise<void> {
    return new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(
        url,
        (texture) => {
          resolve();
          if (this.disposed) return texture.dispose();
          texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
          this.textures.push(texture);
          if ((this.ranks[uniform] ?? -1) > rank) return;
          this.ranks[uniform] = rank;
          this.material.uniforms[uniform].value = texture;
          if (uniform === 'slopes') this.material.uniforms.hasSlopes.value = 1;
          this.requestRender();
        },
        undefined,
        () => reject(new Error(`${url} did not load`)),
      );
    });
  }

  private async loadHeights(url: string): Promise<void> {
    const image = new Image();
    // Read back pixel by pixel, so a map from another origin (the R2 bucket) must come with CORS or the canvas locks.
    image.crossOrigin = 'anonymous';
    image.src = url;
    try {
      await image.decode();
    } catch {
      return;
    }
    if (this.disposed) return;
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    if (!g) return;
    g.drawImage(image, 0, 0);
    this.grid = decodeHeights(g.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
    this.applyRelief();
    this.opts.onHeights?.();
  }

  private async loadNames(url: string): Promise<void> {
    try {
      const json = (await (await fetch(url)).json()) as MarsNamesJson;
      if (this.disposed) return;
      this.features = parseMarsFeatures(json.features);
      this.featureDirs = this.features.map((f) => dirOf(f.latDeg, f.lonDeg));
      this.opts.onFeatures?.(this.features);
      this.requestRender();
    } catch {
      // The globe works without names; the search box just stays empty.
    }
  }

  private makeLabel(): Label {
    const el = document.createElement('div');
    Object.assign(el.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      display: 'none',
      whiteSpace: 'nowrap',
      lineHeight: '1.1',
      color: '#f6efe8',
      textShadow: '0 0 2px #000, 0 0 4px #000, 0 0 6px rgba(0,0,0,.85)',
    });
    this.labelLayer.appendChild(el);
    return { el };
  }

  private paint(el: HTMLElement, f: MarsFeature): void {
    const s = el.style;
    s.fontStyle = 'normal';
    s.letterSpacing = '0';
    const style = labelStyleOf(f.type);
    if (style === 'region') {
      s.font = `400 13px ${FONT}`;
      s.fontStyle = 'italic';
      s.letterSpacing = '.14em';
    } else if (style === 'peak') s.font = `600 12.5px ${FONT}`;
    else if (style === 'linear') {
      s.font = `400 12px ${FONT}`;
      s.fontStyle = 'italic';
    } else s.font = `500 11.5px ${FONT}`;
    if (el.textContent !== f.name) el.textContent = f.name;
  }

  private draw(): void {
    const D = this.camera.position.length();
    // Keep the clip planes tight around the planet so the heights do not flicker.
    this.camera.near = Math.max(0.0004, (D - 1 - (RELIEF_MAX_KM * this.exag) / MARS_RADIUS_KM) * 0.4);
    this.camera.far = D + 2;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.controls.rotateSpeed = clamp((D - 1) * 0.55, 0.04, 0.9);
    this.marker.scale.setScalar(Math.max(0.00012, (D - 1) * 0.004));
    // A headlight from above and to the side of the camera, so the relief always has a shadow side.
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    (this.material.uniforms.camLight.value as THREE.Vector3)
      .copy(this.camera.position)
      .normalize()
      .addScaledVector(up, 0.6)
      .addScaledVector(right, 0.5)
      .normalize();
    this.renderer.render(this.scene, this.camera);
    this.placeLabels(D);
    this.frameListener?.();
    for (const listener of this.frameListeners) listener();
  }

  private placeLabels(D: number): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    let used = 0;
    if (this.showNames && this.features.length) {
      const cam = this.tmp.camera.copy(this.camera.position).normalize();
      const p = this.tmp.p;
      const minDiameterKm =
        D > 3 ? 1500 : D > 2.2 ? 700 : D > 1.7 ? 350 : D > 1.35 ? 150 : D > 1.15 ? 70 : D > 1.06 ? 30 : 8;
      // A label is on the near side when its direction is within the horizon angle of the camera's, plus a margin.
      const limit = 1 / D + 0.03;
      const taken: [number, number, number, number][] = [];
      const order: number[] = [];
      const first = this.selected ? this.features.indexOf(this.selected) : -1;
      if (first >= 0) order.push(first);
      for (let i = 0; i < this.features.length && this.features[i].diameterKm >= minDiameterKm; i++)
        if (i !== first) order.push(i);
      for (const i of order) {
        if (used >= this.pool.length) break;
        const f = this.features[i];
        const dir = this.featureDirs[i];
        if (dir.dot(cam) < limit) continue;
        p.copy(dir).multiplyScalar(this.surfaceRadius(f.latDeg, f.lonDeg)).project(this.camera);
        const x = (p.x * 0.5 + 0.5) * w;
        const y = (-p.y * 0.5 + 0.5) * h - (i === first && this.placed ? 16 : 0);
        if (x < -40 || x > w + 40 || y < -20 || y > h + 20) continue;
        const wide = f.name.length * 7 + 8;
        const box: [number, number, number, number] = [x - wide / 2, y - 8, x + wide / 2, y + 8];
        if (taken.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1])) continue;
        taken.push(box);
        const label = this.pool[used++];
        this.paint(label.el, f);
        label.el.style.display = '';
        label.el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) translate(-50%,-50%)`;
      }
    }
    for (let i = used; i < this.pool.length; i++) this.pool[i].el.style.display = 'none';
  }

  private requestRender(): void {
    if (this.frame || this.flying) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private fit(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    fitCamera(this.camera, w, h, this.insets);
    this.requestRender();
  }

  private readonly onPointerDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY };
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    if (this.flying || !this.down || Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 4) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.globe, false)[0];
    if (!hit) return;
    const { latDeg, lonDeg } = sceneToLonLat(hit.point.x, hit.point.y, hit.point.z);
    this.opts.onPick?.(this.describe(latDeg, lonDeg));
    // Up close the map follows the click; from far away the globe stays put.
    const D = this.camera.position.length();
    if (D < 1.6) void this.flyTo(latDeg, lonDeg, D, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 500);
  };
}
