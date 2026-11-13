import {
  type Dem,
  demHeightM,
  MOON_RADIUS_M,
  polarToUnit,
  polarXY,
  siteFrame,
  unitToLatLon,
  type Vec3,
} from '@siteline/physics';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { fitCamera, type Insets, NO_INSETS } from './screen';

const R_KM = MOON_RADIUS_M / 1000;
const ACCENT = 0x5aa9ff;

// Scene axes in km: the south pole at the origin, local up +Y, 90°E toward +X, the 0° meridian toward −Z.
const sceneDir = (v: Vec3, out = new THREE.Vector3()) => out.set(v[1], -v[2], -v[0]).normalize();
const scenePoint = (q: Vec3, radiusKm: number, out = new THREE.Vector3()) =>
  out.set(q[1] * radiusKm, -q[2] * radiusKm - R_KM, -q[0] * radiusKm);
function bodyUnit(p: THREE.Vector3): Vec3 {
  const v: Vec3 = [-p.z, p.x, -(p.y + R_KM)];
  const n = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / n, v[1] / n, v[2] / n];
}

export interface Region {
  name: string;
  lat: number;
  lon: number;
  sizeKm: number;
}

export interface PoleViewOptions {
  exaggeration?: number;
  regions?: Region[];
  onPick?: (latDeg: number, lonDeg: number) => void;
}

/** Colour for a point in the polar plane (metres), or null for bare ground. */
export type LayerColour = (x: number, y: number) => readonly [number, number, number] | null;

const STRIDE = 2;
const PIN_COLOUR = 0xffb547;

function terrainGeometry(dem: Dem, stride: number, exaggeration: number): THREE.BufferGeometry {
  const m = Math.floor((dem.n - 1) / stride) + 1;
  const half = (dem.n - 1) / 2;
  const pos = new Float32Array(m * m * 3);
  const p = new THREE.Vector3();
  for (let r = 0; r < m; r++) {
    for (let c = 0; c < m; c++) {
      const l = r * stride;
      const s = c * stride;
      const q = polarToUnit((s - half) * dem.pixM, (half - l) * dem.pixM);
      scenePoint(q, R_KM + (dem.heightsM[l * dem.n + s] * exaggeration) / 1000, p).toArray(pos, (r * m + c) * 3);
    }
  }
  const index = new Uint32Array((m - 1) * (m - 1) * 6);
  let k = 0;
  for (let r = 0; r < m - 1; r++) {
    for (let c = 0; c < m - 1; c++) {
      const a = r * m + c;
      index.set([a, a + m, a + 1, a + 1, a + m, a + m + 1], k);
      k += 6;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

export class PoleView {
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(45, 1, 0.5, 6000);
  private readonly controls: OrbitControls;
  private readonly sun = new THREE.DirectionalLight(0xffffff, 3.2);
  private readonly terrain: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  private readonly marker = new THREE.Group();
  private readonly pins = new THREE.Group();
  private readonly overhead = new THREE.HemisphereLight(0xffffff, 0x404040, 0);
  private readonly resize: ResizeObserver;
  private readonly raycaster = new THREE.Raycaster();
  private readonly exaggeration: number;
  private readonly onPick?: (latDeg: number, lonDeg: number) => void;
  private down?: { x: number; y: number };
  private frame = 0;

  private insets: Insets = NO_INSETS;

  constructor(
    private readonly container: HTMLElement,
    private readonly dem: Dem,
    opts: PoleViewOptions = {},
  ) {
    this.exaggeration = opts.exaggeration ?? 3;
    this.onPick = opts.onPick;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.camera.position.set(0, 420, 470);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 1800;
    this.controls.addEventListener('change', () => this.requestRender());

    this.terrain = new THREE.Mesh(
      terrainGeometry(dem, STRIDE, this.exaggeration),
      new THREE.MeshLambertMaterial({ color: 0xbdbdbd }),
    );
    const count = this.terrain.geometry.getAttribute('position').count;
    this.terrain.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    this.terrain.castShadow = true;
    this.terrain.receiveShadow = true;
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.4;
    this.scene.add(
      this.terrain,
      this.sun,
      this.sun.target,
      this.overhead,
      new THREE.AmbientLight(0x6070a0, 0.06),
      this.marker,
      this.pins,
    );
    this.buildMarker();
    if (opts.regions) this.scene.add(this.regionRings(opts.regions));

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(container);
    this.fit();
  }

  /** Sun position relative to the Moon's centre, in km, in the Moon's body-fixed frame. */
  setSun(sunKm: Vec3): void {
    const dir = sceneDir(sunKm);
    this.sun.position.copy(dir).multiplyScalar(2000);
    this.sun.target.position.set(0, 0, 0);
    this.fitShadow();
    this.requestRender();
  }

  setSite(latDeg: number, lonDeg: number): void {
    const q = siteFrame(latDeg, lonDeg).u;
    const p = polarXY(q);
    const h = demHeightM(this.dem, p.x, p.y);
    this.marker.visible = !Number.isNaN(h);
    if (this.marker.visible) {
      scenePoint(q, R_KM + (h * this.exaggeration) / 1000, this.marker.position);
      this.marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), sceneDir(q));
    }
    this.requestRender();
  }

  /** Paint a data layer on the terrain under flat overhead light, or restore sunlight with `null`. */
  setLayer(colour: LayerColour | null): void {
    const material = this.terrain.material;
    material.vertexColors = colour !== null;
    material.needsUpdate = true;
    this.sun.visible = colour === null;
    this.overhead.intensity = colour === null ? 0 : 2.2;
    if (colour) {
      const attr = this.terrain.geometry.getAttribute('color') as THREE.BufferAttribute;
      const m = Math.floor((this.dem.n - 1) / STRIDE) + 1;
      const half = (this.dem.n - 1) / 2;
      for (let r = 0; r < m; r++) {
        for (let c = 0; c < m; c++) {
          const rgb = colour((c * STRIDE - half) * this.dem.pixM, (half - r * STRIDE) * this.dem.pixM) ?? [
            0.42, 0.42, 0.43,
          ];
          attr.setXYZ(r * m + c, rgb[0], rgb[1], rgb[2]);
        }
      }
      attr.needsUpdate = true;
    }
    this.requestRender();
  }

  /** Small flags at the pinned sites. */
  setPins(sites: { latDeg: number; lonDeg: number }[]): void {
    for (const child of [...this.pins.children]) {
      this.pins.remove(child);
      (child as THREE.Mesh).geometry.dispose();
    }
    const material = new THREE.MeshBasicMaterial({ color: PIN_COLOUR });
    for (const s of sites) {
      const q = siteFrame(s.latDeg, s.lonDeg).u;
      const p = polarXY(q);
      const h = demHeightM(this.dem, p.x, p.y);
      if (Number.isNaN(h)) continue;
      const flag = new THREE.Mesh(new THREE.ConeGeometry(2, 7, 10), material);
      scenePoint(q, R_KM + (h * this.exaggeration) / 1000 + 4, flag.position);
      flag.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), sceneDir(q));
      this.pins.add(flag);
    }
    this.requestRender();
  }

  /** Move the camera to look at a site from about `distanceKm` away. */
  focus(latDeg: number, lonDeg: number, distanceKm = 90): void {
    this.setSite(latDeg, lonDeg);
    if (!this.marker.visible) return;
    const offset = this.camera.position.clone().sub(this.controls.target).normalize().multiplyScalar(distanceKm);
    this.controls.target.copy(this.marker.position);
    this.camera.position.copy(this.marker.position).add(offset);
    this.controls.update();
    this.requestRender();
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
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
        o.geometry.dispose();
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((mat) => {
          mat.dispose();
        });
      }
    });
    this.renderer.dispose();
    canvas.remove();
  }

  private requestRender(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.renderer.render(this.scene, this.camera);
    });
  }

  private fit(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    fitCamera(this.camera, w, h, this.insets);
    this.requestRender();
  }

  /** Fit the shadow camera tightly around the terrain as seen from the Sun, so grazing light keeps sharp shadows. */
  private fitShadow(): void {
    const cam = this.sun.shadow.camera;
    cam.position.copy(this.sun.position);
    cam.lookAt(this.sun.target.position);
    cam.updateMatrixWorld();
    const box = this.terrain.geometry.boundingBox;
    if (!box) return;
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity);
    const hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    const v = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      v.applyMatrix4(cam.matrixWorldInverse);
      lo.min(v);
      hi.max(v);
    }
    cam.left = lo.x;
    cam.right = hi.x;
    cam.bottom = lo.y;
    cam.top = hi.y;
    cam.near = -hi.z - 1;
    cam.far = -lo.z + 1;
    cam.updateProjectionMatrix();
  }

  private buildMarker(): void {
    const material = new THREE.MeshBasicMaterial({ color: ACCENT });
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 12, 8), material);
    stem.position.y = 6;
    const head = new THREE.Mesh(new THREE.SphereGeometry(1.6, 16, 12), material);
    head.position.y = 12;
    this.marker.add(stem, head);
    this.marker.visible = false;
  }

  private regionRings(regions: Region[]): THREE.Group {
    const group = new THREE.Group();
    const material = new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.85 });
    for (const region of regions) {
      const { u, e, n } = siteFrame(region.lat, region.lon);
      const th = region.sizeKm / 2 / R_KM;
      const points: THREE.Vector3[] = [];
      for (let i = 0; i < 96; i++) {
        const b = (i / 96) * 2 * Math.PI;
        const d: Vec3 = [
          Math.cos(b) * n[0] + Math.sin(b) * e[0],
          Math.cos(b) * n[1] + Math.sin(b) * e[1],
          Math.cos(b) * n[2] + Math.sin(b) * e[2],
        ];
        const q: Vec3 = [
          Math.cos(th) * u[0] + Math.sin(th) * d[0],
          Math.cos(th) * u[1] + Math.sin(th) * d[1],
          Math.cos(th) * u[2] + Math.sin(th) * d[2],
        ];
        const p = polarXY(q);
        const h = demHeightM(this.dem, p.x, p.y);
        points.push(scenePoint(q, R_KM + ((Number.isNaN(h) ? 0 : h) * this.exaggeration) / 1000 + 0.4));
      }
      group.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), material));
    }
    return group;
  }

  private readonly onPointerDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY };
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    if (!this.down || Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 4) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.terrain, false)[0];
    if (!hit) return;
    const { latDeg, lonDeg } = unitToLatLon(bodyUnit(hit.point));
    this.onPick?.(latDeg, lonDeg);
  };
}
