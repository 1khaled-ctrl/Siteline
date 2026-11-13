import { MOON_RADIUS_M, siteFrame, unitToLatLon, type Vec3 } from '@siteline/physics';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { fitCamera, type Insets, NO_INSETS } from './screen';

const R_KM = MOON_RADIUS_M / 1000;
const ACCENT = 0x5aa9ff;

// Scene axes for the whole Moon, in km: body-fixed (X, Z, −Y). +Y is north, and the default sphere UVs then match
// an equirectangular map centred on 0° longitude.
const toScene = (v: Vec3, out = new THREE.Vector3()) => out.set(v[0], v[2], -v[1]);
const fromScene = (p: THREE.Vector3): Vec3 => [p.x, -p.z, p.y];

const VERTEX = `varying vec2 vUv; varying vec3 vP; varying vec3 vV;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vP = wp.xyz; vV = cameraPosition - wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

// Lunar-Lambert shading. The slope map stores east and north slopes in red and green (from the concept demo).
const FRAGMENT = `uniform sampler2D map; uniform sampler2D slopes; uniform float hasSlopes; uniform float relief; uniform vec3 sunDir;
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
  vec3 L = normalize(sunDir); vec3 V = normalize(vV);
  float m0 = max(dot(n, L), 0.0), mu = max(dot(n, V), 0.0);
  float I = (1.15 * m0 / (m0 + mu + 0.0001) + 0.45 * m0) * smoothstep(-0.045, 0.03, dot(n0, L)) + 0.016;
  gl_FragColor = vec4(texture2D(map, vUv).rgb * I, 1.0);
}`;

export interface GlobeTextures {
  /** Small colour map shown at once. */
  color: string;
  colorHd?: string;
  slopesHd?: string;
}

export interface GlobeViewOptions {
  onPick?: (latDeg: number, lonDeg: number) => void;
}

const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);

export class GlobeView {
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 10, 100_000);
  private readonly controls: OrbitControls;
  private readonly material: THREE.ShaderMaterial;
  private readonly moon: THREE.Mesh;
  private readonly marker = new THREE.Mesh(
    new THREE.SphereGeometry(14, 16, 12),
    new THREE.MeshBasicMaterial({ color: ACCENT }),
  );
  private readonly raycaster = new THREE.Raycaster();
  private readonly resize: ResizeObserver;
  private readonly onPick?: (latDeg: number, lonDeg: number) => void;
  private readonly textures: THREE.Texture[] = [];
  private readonly ranks: Partial<Record<'map' | 'slopes', number>> = {};
  /** Settles once a colour map is on the Moon; fails only when every colour map failed to load. */
  readonly ready: Promise<void>;
  private down?: { x: number; y: number };
  private userMoved = false;
  private flying = false;
  private frame = 0;
  private frameListener?: () => void;

  private insets: Insets = NO_INSETS;

  constructor(
    private readonly container: HTMLElement,
    textures: GlobeTextures,
    opts: GlobeViewOptions = {},
  ) {
    this.onPick = opts.onPick;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        map: { value: null },
        slopes: { value: null },
        hasSlopes: { value: 0 },
        relief: { value: 2.5 },
        sunDir: { value: new THREE.Vector3(1, 0, 0) },
      },
    });
    this.moon = new THREE.Mesh(new THREE.SphereGeometry(R_KM, 256, 128), this.material);
    this.marker.visible = false;
    this.scene.add(this.moon, this.marker);

    this.camera.position.copy(this.viewFrom(0, -35, 4.2 * R_KM));
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.minDistance = R_KM * 1.15;
    this.controls.maxDistance = R_KM * 12;
    this.controls.rotateSpeed = 0.5;
    this.controls.addEventListener('start', () => {
      this.userMoved = true;
    });
    this.controls.addEventListener('change', () => this.requestRender());

    const maps = [this.loadTexture(textures.color, 'map', 0)];
    if (textures.colorHd) maps.push(this.loadTexture(textures.colorHd, 'map', 1));
    if (textures.slopesHd) this.loadTexture(textures.slopesHd, 'slopes', 1).catch(() => {});
    this.ready = Promise.any(maps);

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(container);
    this.fit();
  }

  /** Sun position relative to the Moon's centre, in km, in the Moon's body-fixed frame. */
  setSun(sunKm: Vec3): void {
    const dir = toScene(sunKm).normalize();
    (this.material.uniforms.sunDir.value as THREE.Vector3).copy(dir);
    if (!this.userMoved && !this.flying) {
      // Face the sunlit side, tilted to show the south pole.
      const sunLonDeg = (Math.atan2(sunKm[1], sunKm[0]) * 180) / Math.PI;
      this.camera.position.copy(this.viewFrom(sunLonDeg + 25, -35, this.camera.position.length()));
      this.controls.update();
    }
    this.requestRender();
  }

  setSite(latDeg: number, lonDeg: number): void {
    toScene(siteFrame(latDeg, lonDeg).u, this.marker.position).multiplyScalar(R_KM + 2);
    this.marker.visible = true;
    this.requestRender();
  }

  /** Swing the camera down over the south pole; resolves when it arrives. */
  flyToSouthPole(durationMs = 2600): Promise<void> {
    const startPos = this.camera.position.clone();
    const startTarget = this.controls.target.clone();
    const endTarget = new THREE.Vector3(0, -R_KM, 0);
    // Matches the south-pole view's opening camera: 420 km up, 470 km out toward the 180° meridian.
    const endPos = new THREE.Vector3(-470, -R_KM - 420, 0);
    const turn = new THREE.Quaternion().setFromUnitVectors(startPos.clone().normalize(), endPos.clone().normalize());
    const still = new THREE.Quaternion();
    const q = new THREE.Quaternion();
    const r0 = startPos.length();
    const r1 = endPos.length();
    this.flying = true;
    this.controls.enabled = false;
    return new Promise((resolve) => {
      const t0 = performance.now();
      const step = () => {
        const k = durationMs <= 0 ? 1 : Math.min(1, (performance.now() - t0) / durationMs);
        const e = easeInOut(k);
        q.slerpQuaternions(still, turn, e);
        this.camera.position
          .copy(startPos)
          .normalize()
          .applyQuaternion(q)
          .multiplyScalar(r0 + (r1 - r0) * e);
        this.controls.target.lerpVectors(startTarget, endTarget, e);
        this.camera.lookAt(this.controls.target);
        this.renderer.render(this.scene, this.camera);
        this.frameListener?.();
        if (k < 1) this.frame = requestAnimationFrame(step);
        else {
          this.frame = 0;
          resolve();
        }
      };
      this.frame = requestAnimationFrame(step);
    });
  }

  /** Called after every draw, so overlays such as the lander pins can follow the camera. */
  setFrameListener(listener: (() => void) | undefined): void {
    this.frameListener = listener;
  }

  /** Where a place is in the view, in pixels; undefined when it is on the far side of the Moon. */
  project(latDeg: number, lonDeg: number): { xPx: number; yPx: number } | undefined {
    const dir = toScene(siteFrame(latDeg, lonDeg).u);
    // On the near side when within the horizon angle of the camera's direction, plus a margin.
    if (dir.dot(this.camera.position.clone().normalize()) < R_KM / this.camera.position.length() + 0.01)
      return undefined;
    this.camera.updateMatrixWorld();
    const p = dir.multiplyScalar(R_KM).project(this.camera);
    if (p.z > 1) return undefined;
    const { clientWidth: w, clientHeight: h } = this.container;
    return { xPx: (p.x * 0.5 + 0.5) * w, yPx: (-p.y * 0.5 + 0.5) * h };
  }

  /** True when the camera is close enough that every lander can carry a name. */
  isClose(): boolean {
    return this.camera.position.length() < 2.2 * R_KM;
  }

  /** Swing the camera over a place, `distanceKm` from the Moon's centre; resolves when it arrives. */
  flyTo(latDeg: number, lonDeg: number, distanceKm: number, durationMs = 1400): Promise<void> {
    const startPos = this.camera.position.clone();
    const startTarget = this.controls.target.clone();
    const r1 = Math.min(this.controls.maxDistance, Math.max(this.controls.minDistance, distanceKm));
    const endDir = toScene(siteFrame(latDeg, lonDeg).u);
    const turn = new THREE.Quaternion().setFromUnitVectors(startPos.clone().normalize(), endDir);
    const still = new THREE.Quaternion();
    const q = new THREE.Quaternion();
    const r0 = startPos.length();
    const origin = new THREE.Vector3();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.userMoved = true;
    this.flying = true;
    this.controls.enabled = false;
    return new Promise((resolve) => {
      const t0 = performance.now();
      const step = () => {
        const k = durationMs <= 0 ? 1 : Math.min(1, (performance.now() - t0) / durationMs);
        const e = easeInOut(k);
        q.slerpQuaternions(still, turn, e);
        this.camera.position
          .copy(startPos)
          .normalize()
          .applyQuaternion(q)
          .multiplyScalar(r0 + (r1 - r0) * e);
        this.controls.target.lerpVectors(startTarget, origin, e);
        this.camera.lookAt(this.controls.target);
        this.renderer.render(this.scene, this.camera);
        this.frameListener?.();
        if (k < 1) this.frame = requestAnimationFrame(step);
        else {
          this.frame = 0;
          this.flying = false;
          this.controls.enabled = true;
          this.controls.update();
          resolve();
        }
      };
      this.frame = requestAnimationFrame(step);
    });
  }

  /** How much of the canvas the app's panels cover; the view centres itself in the rest. */
  setInsets(insets: Insets): void {
    this.insets = insets;
    this.fit();
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.controls.dispose();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    for (const t of this.textures) t.dispose();
    this.moon.geometry.dispose();
    this.material.dispose();
    this.marker.geometry.dispose();
    (this.marker.material as THREE.Material).dispose();
    this.renderer.dispose();
    canvas.remove();
  }

  private viewFrom(lonDeg: number, latDeg: number, distanceKm: number): THREE.Vector3 {
    return toScene(siteFrame(latDeg, lonDeg).u).multiplyScalar(distanceKm);
  }

  /** Higher `rank` wins, so a small preview never replaces a high-resolution map that arrived first. */
  private loadTexture(url: string, uniform: 'map' | 'slopes', rank: number): Promise<void> {
    return new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(
        url,
        (texture) => {
          texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
          this.textures.push(texture);
          resolve();
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

  private requestRender(): void {
    if (this.frame || this.flying) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.renderer.render(this.scene, this.camera);
      this.frameListener?.();
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
    const hit = this.raycaster.intersectObject(this.moon, false)[0];
    if (!hit) return;
    const { latDeg, lonDeg } = unitToLatLon(fromScene(hit.point.clone().normalize()));
    this.onPick?.(latDeg, lonDeg);
  };
}
