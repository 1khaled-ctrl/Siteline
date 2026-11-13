import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { lonLatToScene } from './earthData';
import type { SurfaceLine } from './landerData';
import { patchHeightM, patchSlopes, type SitePatch } from './sitePatch';

export type SiteBody = 'Moon' | 'Mars';

/** What an overlay needs from a 3D view to put markers on it. */
export interface PinHost {
  /** Where a place is in the view, in pixels; undefined when it is out of sight. */
  project(latDeg: number, lonDeg: number): { xPx: number; yPx: number } | undefined;
  /** Called after every draw. */
  setFrameListener(listener: (() => void) | undefined): void;
  /** True when the camera is close enough that every marker can carry a name. */
  isClose(): boolean;
}

/** Mean radius of each body, as the maps use it (kilometres). */
export const SITE_BODY_RADIUS_KM: Record<SiteBody, number> = { Moon: 1737.4, Mars: 3389.5 };
const GRID = 257;
const PIN_LIFT_M = 60;
const ROUTE_LIFT_M = 80;
const ROUTE_DOT_LIFT_M = 100;
const DEG = Math.PI / 180;

const VERTEX = `uniform vec3 centre; attribute vec2 patchUv;
varying vec2 vP; varying vec3 vDir; varying vec3 vView; varying vec2 vG;
void main() {
  vP = patchUv;
  vDir = normalize(position + centre);
  vG = vec2(atan(-vDir.z, vDir.x) / 6.2831853 + 0.5, asin(clamp(vDir.y, -1.0, 1.0)) / 3.1415927 + 0.5);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vView = cameraPosition - wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

// The slope map holds the east and north tilt of the ground (square-root coded) in red and green. The Moon is shaded
// like the globe (Lommel-Seeliger plus a little Lambert); Mars with plain Lambert and some sky light.
const FRAGMENT = `uniform sampler2D map; uniform sampler2D slopes; uniform vec4 crop; uniform float hasMap;
uniform float relief; uniform float lunar; uniform float realLight; uniform vec3 sunDir; uniform vec3 studioDir;
varying vec2 vP; varying vec3 vDir; varying vec3 vView; varying vec2 vG;
void main() {
  vec3 n0 = normalize(vDir);
  vec3 c = cross(vec3(0.0, 1.0, 0.0), n0); float cl = length(c);
  vec3 east = cl > 1e-5 ? c / cl : vec3(0.0, 0.0, -1.0); vec3 north = cross(n0, east);
  vec2 s = texture2D(slopes, vP).rg * 2.0 - 1.0;
  vec2 nxy = sign(s) * s * s; float nz = sqrt(max(0.0, 1.0 - dot(nxy, nxy)));
  vec3 n = normalize((east * nxy.x + north * nxy.y) * relief + n0 * nz);
  vec3 L = normalize(realLight > 0.5 ? sunDir : studioDir); vec3 V = normalize(vView);
  float m0 = max(dot(n, L), 0.0), mu = max(dot(n, V), 0.0);
  float up = realLight > 0.5 ? smoothstep(-0.045, 0.03, dot(n0, L)) : 1.0;
  float I = lunar > 0.5 ? (1.15 * m0 / (m0 + mu + 0.0001) + 0.45 * m0) * up + 0.016 : (0.18 + 1.15 * m0) * up + 0.012;
  vec3 base = hasMap > 0.5 ? texture2D(map, (vG - crop.xy) / crop.zw).rgb : vec3(0.5);
  gl_FragColor = vec4(base * I, 1.0);
}`;

export interface SiteViewOptions {
  body: SiteBody;
  patch: SitePatch;
  /** The body's whole-planet colour map; the part around the site is cut out of it. */
  colourUrl: string;
}

/** The terrain around one landing site, drawn from its height patch and orbitable. Distances are in kilometres. */
export class SiteView implements PinHost {
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.05, 2000);
  private readonly controls: OrbitControls;
  private readonly material: THREE.ShaderMaterial;
  private readonly mesh: THREE.Mesh;
  private readonly slopeTexture: THREE.DataTexture;
  private readonly radiusKm: number;
  private readonly centre: THREE.Vector3;
  private readonly up: THREE.Vector3;
  private readonly widthKm: number;
  private readonly resize: ResizeObserver;
  private readonly tmp = new THREE.Vector3();
  private colourTexture?: THREE.Texture;
  private routes: readonly SurfaceLine[] = [];
  private routeObjects: (THREE.Line | THREE.Points)[] = [];
  private exag = 3;
  private frameListener?: () => void;
  private frame = 0;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly opts: SiteViewOptions,
  ) {
    const { patch, body } = opts;
    const { meta } = patch;
    this.radiusKm = SITE_BODY_RADIUS_KM[body];
    this.widthKm = 2 * meta.halfDeg * DEG * this.radiusKm;
    const dir = new THREE.Vector3(...lonLatToScene(meta.latDeg, meta.lonDeg));
    this.up = dir.clone();
    this.centre = dir.clone().multiplyScalar(this.radiusKm);

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.slopeTexture = new THREE.DataTexture(
      patchSlopes(patch, this.radiusKm * 1000),
      patch.width,
      patch.height,
      THREE.RGBAFormat,
    );
    this.slopeTexture.magFilter = THREE.LinearFilter;
    this.slopeTexture.minFilter = THREE.LinearMipmapLinearFilter;
    this.slopeTexture.generateMipmaps = true;
    this.slopeTexture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.slopeTexture.needsUpdate = true;

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: THREE.DoubleSide,
      uniforms: {
        centre: { value: this.centre },
        map: { value: null },
        slopes: { value: this.slopeTexture },
        crop: { value: new THREE.Vector4(0, 0, 1, 1) },
        hasMap: { value: 0 },
        relief: { value: this.exag },
        lunar: { value: body === 'Moon' ? 1 : 0 },
        realLight: { value: 0 },
        sunDir: { value: new THREE.Vector3(1, 0, 0) },
        studioDir: { value: this.studioLight() },
      },
    });
    this.mesh = new THREE.Mesh(this.buildGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);

    this.camera.up.copy(this.up);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enablePan = false;
    this.controls.minDistance = this.widthKm * 0.05;
    this.controls.maxDistance = this.widthKm * 3;
    this.controls.maxPolarAngle = 80 * DEG;
    this.controls.addEventListener('change', () => this.requestRender());
    this.home();

    void this.loadColour();
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(container);
    this.fit();
  }

  setFrameListener(listener: (() => void) | undefined): void {
    this.frameListener = listener;
  }

  isClose(): boolean {
    return true;
  }

  /** Where a place is in the view, in pixels; undefined when it is behind the camera. */
  project(latDeg: number, lonDeg: number): { xPx: number; yPx: number } | undefined {
    this.camera.updateMatrixWorld();
    const p = this.localPoint(latDeg, lonDeg, PIN_LIFT_M, this.tmp).project(this.camera);
    if (p.z > 1) return undefined;
    const { clientWidth: w, clientHeight: h } = this.container;
    return { xPx: (p.x * 0.5 + 0.5) * w, yPx: (-p.y * 0.5 + 0.5) * h };
  }

  /** Stretch the heights (and with them the shading) by a factor. */
  setRelief(exaggeration: number): void {
    this.exag = exaggeration;
    this.material.uniforms.relief.value = exaggeration;
    this.updateGeometry(this.mesh.geometry);
    this.buildRoutes();
    this.aimAtSite();
    this.requestRender();
  }

  /** Light the ground with the real Sun, given the point on the planet it is straight above; undefined = studio light. */
  setSubsolar(point: { latDeg: number; lonDeg: number } | undefined): void {
    this.material.uniforms.realLight.value = point ? 1 : 0;
    if (point) this.material.uniforms.sunDir.value.set(...lonLatToScene(point.latDeg, point.lonDeg));
    this.requestRender();
  }

  /** Rover routes and helicopter flights, draped on the ground. */
  setRoutes(lines: readonly SurfaceLine[]): void {
    this.routes = lines;
    this.buildRoutes();
    this.requestRender();
  }

  /** Back to the opening view: south of the site, looking north from about 35° up. */
  home(): void {
    const north = this.northAt();
    const el = 35 * DEG;
    const dist = this.widthKm * 0.9;
    this.aimAtSite();
    this.camera.position
      .copy(this.controls.target)
      .addScaledVector(north, -Math.cos(el) * dist)
      .addScaledVector(this.up, Math.sin(el) * dist);
    this.controls.update();
    this.requestRender();
  }

  zoomBy(factor: number): void {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const d = Math.min(this.controls.maxDistance, Math.max(this.controls.minDistance, offset.length() * factor));
    this.camera.position.copy(this.controls.target).addScaledVector(offset.normalize(), d);
    this.controls.update();
    this.requestRender();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.controls.dispose();
    this.clearRoutes();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.slopeTexture.dispose();
    this.colourTexture?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private northAt(): THREE.Vector3 {
    const east = new THREE.Vector3(0, 1, 0).cross(this.up);
    if (east.lengthSq() < 1e-10) east.set(0, 0, -1);
    east.normalize();
    return this.up.clone().cross(east).normalize();
  }

  /** Light from the north-west at 35°, the way relief is drawn on maps; the same on any turn of the camera. */
  private studioLight(): THREE.Vector3 {
    const north = this.northAt();
    const east = north.clone().cross(this.up).negate();
    const el = 35 * DEG;
    return this.up
      .clone()
      .multiplyScalar(Math.sin(el))
      .addScaledVector(north, 0.55 * Math.cos(el))
      .addScaledVector(east, -0.8 * Math.cos(el))
      .normalize();
  }

  private aimAtSite(): void {
    const { meta } = this.opts.patch;
    const h = patchHeightM(this.opts.patch, meta.latDeg, meta.lonDeg) ?? 0;
    this.controls.target.copy(this.up).multiplyScalar((h * this.exag) / 1000);
  }

  /** A place on the ground, `liftM` above it, relative to the site's point on the reference sphere (km). */
  private localPoint(latDeg: number, lonDeg: number, liftM: number, out: THREE.Vector3): THREE.Vector3 {
    const h = patchHeightM(this.opts.patch, latDeg, lonDeg) ?? 0;
    return out
      .set(...lonLatToScene(latDeg, lonDeg))
      .multiplyScalar(this.radiusKm + ((h + liftM) * this.exag) / 1000)
      .sub(this.centre);
  }

  private buildGeometry(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    const uv = new Float32Array(GRID * GRID * 2);
    for (let i = 0; i < GRID; i++)
      for (let j = 0; j < GRID; j++) uv.set([j / (GRID - 1), i / (GRID - 1)], (i * GRID + j) * 2);
    const index = new Uint32Array((GRID - 1) * (GRID - 1) * 6);
    let q = 0;
    for (let i = 0; i < GRID - 1; i++)
      for (let j = 0; j < GRID - 1; j++) {
        const a = i * GRID + j;
        const b = a + 1;
        const c = a + GRID;
        const d = c + 1;
        index.set([a, c, b, b, c, d], q);
        q += 6;
      }
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(GRID * GRID * 3), 3));
    geometry.setAttribute('patchUv', new THREE.BufferAttribute(uv, 2));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    this.updateGeometry(geometry);
    return geometry;
  }

  private updateGeometry(geometry: THREE.BufferGeometry): void {
    const { meta } = this.opts.patch;
    const pos = geometry.attributes.position;
    const p = new THREE.Vector3();
    for (let i = 0; i < GRID; i++)
      for (let j = 0; j < GRID; j++) {
        // Clamp so the last row and column stay inside the patch despite rounding.
        const lat = meta.latDeg + meta.halfDeg * (1 - (2 * i) / (GRID - 1)) * 0.999999;
        const lon = meta.lonDeg + meta.halfDeg * ((2 * j) / (GRID - 1) - 1) * 0.999999;
        this.localPoint(lat, lon, 0, p);
        pos.setXYZ(i * GRID + j, p.x, p.y, p.z);
      }
    pos.needsUpdate = true;
    geometry.computeBoundingSphere();
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
    const { patch } = this.opts;
    for (const line of this.routes) {
      const lift = line.dots ? ROUTE_DOT_LIFT_M : ROUTE_LIFT_M;
      const points = line.points
        .filter(([lat, lon]) => patchHeightM(patch, lat, lon) !== undefined)
        .map(([lat, lon]) => this.localPoint(lat, lon, lift, new THREE.Vector3()));
      if (!points.length) continue;
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const object = line.dots
        ? new THREE.Points(
            geometry,
            new THREE.PointsMaterial({ color: line.colourHex, size: 5, sizeAttenuation: false }),
          )
        : new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: line.colourHex }));
      object.frustumCulled = false;
      this.scene.add(object);
      this.routeObjects.push(object);
    }
  }

  /** Cut the part of the whole-planet colour map around the site into a small texture. */
  private loadColour(): Promise<void> {
    const { meta } = this.opts.patch;
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        if (this.disposed) return resolve();
        const margin = 1.25;
        const halfLat = meta.halfDeg * margin;
        const halfLon = meta.halfDeg * margin;
        const x0 = ((meta.lonDeg - halfLon + 180) / 360) * img.naturalWidth;
        const y0 = ((90 - (meta.latDeg + halfLat)) / 180) * img.naturalHeight;
        const sw = ((2 * halfLon) / 360) * img.naturalWidth;
        const sh = ((2 * halfLat) / 180) * img.naturalHeight;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 256;
        const g = canvas.getContext('2d');
        if (!g) return resolve();
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, x0, y0, sw, sh, 0, 0, 256, 256);
        this.colourTexture = new THREE.CanvasTexture(canvas);
        this.colourTexture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        this.material.uniforms.map.value = this.colourTexture;
        this.material.uniforms.hasMap.value = 1;
        // Texture coordinates: u across longitude, v up from the south edge of the cut.
        (this.material.uniforms.crop.value as THREE.Vector4).set(
          (meta.lonDeg - halfLon + 180) / 360,
          (meta.latDeg - halfLat + 90) / 180,
          (2 * halfLon) / 360,
          (2 * halfLat) / 180,
        );
        this.requestRender();
        resolve();
      };
      img.onerror = () => resolve();
      img.src = this.opts.colourUrl;
    });
  }

  private draw(): void {
    const dist = this.camera.position.distanceTo(this.controls.target);
    this.camera.near = Math.max(0.02, dist * 0.02);
    this.camera.far = dist + this.widthKm * 4;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.controls.rotateSpeed = 0.6;
    this.renderer.render(this.scene, this.camera);
    this.frameListener?.();
  }

  private requestRender(): void {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private fit(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }
}
