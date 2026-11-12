import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  countryAt,
  EARTH_MEAN_RADIUS_KM,
  type EarthCity,
  type EarthCountriesJson,
  type EarthCountry,
  type EarthDetailJson,
  type EarthIds,
  lineSegments,
  lonLatToScene,
  nearestCity,
  parseCities,
  parseCountries,
  sceneToLonLat,
} from './earthData';

export type EarthStyle = 'map' | 'satellite' | 'night';

export interface EarthAssets {
  map: string;
  satellite: string;
  night: string;
  /** Raster of country ids, for telling which country a click landed in. */
  ids: string;
  /** Natural Earth 1:50m coast, borders and country labels. */
  countries: string;
  /** Natural Earth 1:10m provinces, roads, rivers, lakes, coast and cities; loaded on the first close zoom. */
  detail: string;
}

export type ContinentKey = 'africa' | 'europe' | 'asia' | 'northAmerica' | 'southAmerica' | 'oceania' | 'antarctica';
export type OceanKey = 'pacific' | 'atlantic' | 'indian' | 'arctic' | 'southern';

export interface EarthPlace {
  latDeg: number;
  lonDeg: number;
  country?: EarthCountry;
  /** The nearest city within PICK_CITY_KM of the point. */
  city?: EarthCity;
  cityDistKm?: number;
}

export interface EarthViewOptions {
  assets: EarthAssets;
  /** Words for the continent and ocean labels. */
  names: Record<ContinentKey | OceanKey, string>;
  onPick?: (place: EarthPlace) => void;
  /** Called once the country list has loaded, for a search box. */
  onCountries?: (countries: readonly EarthCountry[]) => void;
}

/** A click picks a city only this close to it. */
export const PICK_CITY_KM = 60;
/** The country raster has about 19 km pixels, so a click this close to a city on a coast can read as sea. */
const COAST_SLACK_KM = 20;

const ACCENT = 0x5aa9ff;
const HOME = { latDeg: 25, lonDeg: 35, distance: 3.6 };
const SKIP_LABELS = new Set([
  'Siachen Glacier',
  'Indian Ocean Ter.',
  'Ashmore and Cartier Is.',
  'N. Cyprus',
  'Somaliland',
  'Antarctica',
]);
// Label anchors from the concept demo: [name, latitude, longitude].
const CONTINENTS: [ContinentKey, number, number][] = [
  ['africa', 4, 20],
  ['europe', 53, 14],
  ['asia', 47, 90],
  ['northAmerica', 47, -101],
  ['southAmerica', -12, -58],
  ['oceania', -32, 148],
  ['antarctica', -80, 30],
];
const OCEANS: [OceanKey, number, number][] = [
  ['pacific', 2, -150],
  ['pacific', 12, 165],
  ['atlantic', 28, -42],
  ['atlantic', -24, -14],
  ['indian', -18, 78],
  ['arctic', 84, -10],
  ['southern', -62, 95],
];
const FONT = '"IBM Plex Sans", system-ui, sans-serif';

const VERTEX = `varying vec2 vUv; varying vec3 vN; varying vec3 vV;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

// Day side lit by the real Sun when `realLight` is on; the night side shows the city lights.
const FRAGMENT = `uniform sampler2D dayMap; uniform sampler2D nightMap; uniform vec3 sunDir; uniform float realLight; uniform float nightOnly;
varying vec2 vUv; varying vec3 vN; varying vec3 vV;
void main() {
  vec3 day = texture2D(dayMap, vUv).rgb; vec3 night = texture2D(nightMap, vUv).rgb; vec3 n = normalize(vN);
  float d = dot(n, normalize(sunDir)); float k = smoothstep(-0.1, 0.1, d);
  vec3 lit = day * (0.62 + 0.38 * clamp(d * 1.6, 0.0, 1.0));
  vec3 dark = day * 0.16 + night * vec3(1.1, 0.95, 0.75);
  vec3 col = mix(day, mix(dark, lit, k), realLight);
  if (nightOnly > 0.5) col = night * 1.15 + day * 0.035;
  float f = pow(1.0 - max(dot(n, normalize(vV)), 0.0), 2.8);
  col = mix(col, vec3(0.66, 0.83, 1.0), f * 0.42);
  gl_FragColor = vec4(col, 1.0);
}`;

const ATMOSPHERE_FRAGMENT = `uniform vec3 glow; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
void main() { float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 4.5); gl_FragColor = vec4(glow, f * 0.75); }`;

type LabelKind = 'country' | 'continent' | 'ocean';
interface Label {
  el: HTMLElement;
  kind: LabelKind;
  dir: THREE.Vector3;
  widthPx: number;
  heightPx: number;
  rank: number;
  countryId: number;
  big: boolean;
}
interface CityLabel {
  el: HTMLElement;
  dot: HTMLElement;
  text: Text;
}

const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const dirOf = (latDeg: number, lonDeg: number) => new THREE.Vector3(...lonLatToScene(latDeg, lonDeg));

function lines(b64: string, radius: number, material: THREE.LineBasicMaterial): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(lineSegments(b64), 3));
  const mesh = new THREE.LineSegments(geometry, material);
  // The geometry is on the unit sphere; the radius lifts each layer a hair above the one below to stop z-fighting.
  mesh.scale.setScalar(radius);
  return mesh;
}

/** A map-style globe of the Earth: NASA imagery, Natural Earth borders and names, and cities and roads up close. */
export class EarthView {
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 0.01, 50);
  private readonly controls: OrbitControls;
  private readonly material: THREE.ShaderMaterial;
  private readonly globe: THREE.Mesh;
  private readonly marker = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 12),
    new THREE.MeshBasicMaterial({ color: ACCENT }),
  );
  private readonly coastMat = new THREE.LineBasicMaterial({ transparent: true });
  private readonly borderMat = new THREE.LineBasicMaterial({ transparent: true });
  private readonly provMat = new THREE.LineBasicMaterial({ transparent: true });
  private readonly roadMat = new THREE.LineBasicMaterial({ color: 0xd9935a, transparent: true });
  private readonly riverMat = new THREE.LineBasicMaterial({ color: 0x6fa8dc, transparent: true, opacity: 0.85 });
  private readonly coast10Mat = new THREE.LineBasicMaterial({ color: 0x86b9de, transparent: true, opacity: 0.8 });
  private readonly detail = new THREE.Group();
  private readonly detailLines: Partial<Record<'prov' | 'roads' | 'rivers' | 'lakes' | 'coast', THREE.LineSegments>> =
    {};
  private readonly textures: Partial<Record<EarthStyle, THREE.Texture>> = {};
  private readonly labelLayer = document.createElement('div');
  private readonly labels: Label[] = [];
  private readonly cityPool: CityLabel[] = [];
  private readonly byId = new Map<number, EarthCountry>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly resize: ResizeObserver;
  private readonly dirs = { camera: new THREE.Vector3(), tmp: new THREE.Vector3() };
  private countryList: EarthCountry[] = [];
  private cities: EarthCity[] = [];
  private ids?: EarthIds;
  private detailPromise?: Promise<void>;
  private detailRetryAtMs = 0;
  private cityDark = false;
  private flightId = 0;
  /** Where the flight in progress ends, so a zoom during it builds on the destination, not the half-way point. */
  private destination?: { latDeg: number; lonDeg: number; distance: number };
  private style: EarthStyle = 'map';
  private realLight = false;
  private selectedId = -1;
  private placed: { latDeg: number; lonDeg: number } | undefined;
  private down?: { x: number; y: number };
  private flying = false;
  private frame = 0;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly opts: EarthViewOptions,
  ) {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        dayMap: { value: null },
        nightMap: { value: null },
        sunDir: { value: new THREE.Vector3(1, 0, 0) },
        realLight: { value: 0 },
        nightOnly: { value: 0 },
      },
    });
    this.globe = new THREE.Mesh(new THREE.SphereGeometry(1, 192, 96), this.material);
    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.055, 96, 48),
      new THREE.ShaderMaterial({
        uniforms: { glow: { value: new THREE.Color(0.42, 0.68, 1) } },
        vertexShader: VERTEX,
        fragmentShader: ATMOSPHERE_FRAGMENT,
        side: THREE.BackSide,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.marker.visible = false;
    this.detail.visible = false;
    this.scene.add(this.globe, atmosphere, this.detail, this.marker);

    this.camera.position.copy(dirOf(HOME.latDeg, HOME.lonDeg).multiplyScalar(HOME.distance));
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enablePan = false;
    this.controls.minDistance = 1.004;
    this.controls.maxDistance = 8;
    this.controls.addEventListener('change', () => this.requestRender());

    Object.assign(this.labelLayer.style, {
      position: 'absolute',
      inset: '0',
      overflow: 'hidden',
      pointerEvents: 'none',
    });
    container.appendChild(this.labelLayer);
    this.addFixedLabels();
    for (let i = 0; i < 110; i++) this.cityPool.push(this.makeCityLabel());

    this.applyStyle();
    void this.loadTexture('map');
    void this.loadTexture('night');
    void this.loadCountries();
    void this.loadIds();

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(container);
    this.fit();
  }

  /** Countries with a label, in dataset order; for a search box. */
  countries(): readonly EarthCountry[] {
    return this.countryList;
  }

  setStyle(style: EarthStyle): void {
    this.style = style;
    void this.loadTexture(style);
    this.applyStyle();
  }

  /** Light the globe with the real Sun: day on one side, city lights on the other. */
  setRealLight(on: boolean): void {
    this.realLight = on;
    this.applyStyle();
  }

  /** Where the Sun is overhead; only matters while real light is on. */
  setSubsolar(latDeg: number, lonDeg: number): void {
    (this.material.uniforms.sunDir.value as THREE.Vector3).copy(dirOf(latDeg, lonDeg));
    this.requestRender();
  }

  /** Mark a place, or clear the mark. `selectedCountryId` keeps that country's name on screen. */
  setPlace(place: { latDeg: number; lonDeg: number; countryId?: number } | undefined): void {
    this.placed = place;
    this.selectedId = place?.countryId ?? -1;
    this.marker.visible = !!place;
    if (place) this.marker.position.copy(dirOf(place.latDeg, place.lonDeg).multiplyScalar(1.003));
    this.requestRender();
  }

  /** Swing the camera over a point at `distance` Earth radii from the centre. */
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

  /** Frame a whole country; bigger countries get a farther camera. */
  flyToCountry(c: EarthCountry, durationMs = 1400): Promise<void> {
    return this.flyTo(
      c.latDeg,
      c.lonDeg,
      1 + clamp((3.2 * Math.sqrt(c.areaKm2)) / EARTH_MEAN_RADIUS_KM, 0.06, 2.3),
      durationMs,
    );
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

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.controls.dispose();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        o.geometry.dispose();
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
          m.dispose();
        });
      }
    });
    for (const t of Object.values(this.textures)) t?.dispose();
    this.renderer.dispose();
    this.labelLayer.remove();
    canvas.remove();
  }

  private async loadTexture(style: EarthStyle): Promise<void> {
    if (this.textures[style]) return;
    const url = this.opts.assets[style];
    const texture = await new THREE.TextureLoader().loadAsync(url);
    if (this.disposed) return texture.dispose();
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.textures[style] = texture;
    this.applyStyle();
  }

  private async loadCountries(): Promise<void> {
    const json = (await (await fetch(this.opts.assets.countries)).json()) as EarthCountriesJson;
    if (this.disposed) return;
    this.countryList = parseCountries(json).filter((c) => !SKIP_LABELS.has(c.name));
    for (const c of parseCountries(json)) this.byId.set(c.id, c);
    this.scene.add(lines(json.coast, 1.0008, this.coastMat), lines(json.borders, 1.0012, this.borderMat));
    for (const c of this.countryList) this.addLabel('country', c.name, c.latDeg, c.lonDeg, c.rank, c.id, c.rank <= 30);
    this.applyStyle();
    this.opts.onCountries?.(this.countryList);
  }

  private async loadIds(): Promise<void> {
    const image = await new Promise<HTMLImageElement | undefined>((resolve) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => resolve(undefined);
      im.src = this.opts.assets.ids;
    });
    if (!image || this.disposed) return;
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    if (!g) return;
    g.drawImage(image, 0, 0);
    this.ids = g.getImageData(0, 0, canvas.width, canvas.height);
  }

  /** Fetch the close-up layers once; a failure is retried after 5 s, not on every frame. */
  private loadDetail(): Promise<void> {
    if (!this.detailPromise && performance.now() >= this.detailRetryAtMs) {
      this.detailPromise = this.fetchDetail().catch(() => {
        // The globe still works without the close-up layers.
        this.detailPromise = undefined;
        this.detailRetryAtMs = performance.now() + 5000;
      });
    }
    return this.detailPromise ?? Promise.resolve();
  }

  private async fetchDetail(): Promise<void> {
    {
      const json = (await (await fetch(this.opts.assets.detail)).json()) as EarthDetailJson;
      if (this.disposed) return;
      this.cities = parseCities(json.cities);
      const layers: ['prov' | 'roads' | 'rivers' | 'lakes' | 'coast', number, THREE.LineBasicMaterial][] = [
        ['prov', 1.00075, this.provMat],
        ['roads', 1.0009, this.roadMat],
        ['rivers', 1.0006, this.riverMat],
        ['lakes', 1.0006, this.riverMat],
        ['coast', 1.0005, this.coast10Mat],
      ];
      for (const [key, radius, material] of layers) {
        const mesh = lines(json[key], radius, material);
        this.detailLines[key] = mesh;
        this.detail.add(mesh);
      }
      this.detail.visible = true;
      this.applyStyle();
    }
  }

  private addFixedLabels(): void {
    for (const [key, lat, lon] of CONTINENTS) this.addLabel('continent', this.opts.names[key], lat, lon, 0, -1, false);
    for (const [key, lat, lon] of OCEANS) this.addLabel('ocean', this.opts.names[key], lat, lon, 9999, -1, false);
  }

  private addLabel(
    kind: LabelKind,
    text: string,
    lat: number,
    lon: number,
    rank: number,
    countryId: number,
    big: boolean,
  ): void {
    const el = document.createElement('div');
    el.textContent = text;
    Object.assign(el.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      display: 'none',
      whiteSpace: 'pre',
      textAlign: 'center',
      lineHeight: '1.15',
      font: `500 ${big ? 13.5 : 12}px ${FONT}`,
    });
    this.labelLayer.appendChild(el);
    const perChar = kind === 'continent' ? 13 : kind === 'ocean' ? 10.5 : 7.2;
    this.labels.push({
      el,
      kind,
      dir: dirOf(lat, lon),
      widthPx: text.length * perChar + 10,
      heightPx: 18,
      rank,
      countryId,
      big,
    });
  }

  private makeCityLabel(): CityLabel {
    const el = document.createElement('div');
    const dot = document.createElement('span');
    const text = document.createTextNode('');
    Object.assign(el.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      display: 'none',
      whiteSpace: 'nowrap',
      lineHeight: '1.1',
    });
    Object.assign(dot.style, {
      display: 'inline-block',
      borderRadius: '50%',
      border: '1px solid',
      marginInlineEnd: '4px',
      verticalAlign: '1px',
    });
    el.append(dot, text);
    this.labelLayer.appendChild(el);
    return { el, dot, text };
  }

  /** The lines, labels and light follow the chosen style; the map style is bright with dark labels. */
  private applyStyle(): void {
    const u = this.material.uniforms;
    u.dayMap.value = this.textures[this.style === 'night' ? 'map' : this.style] ?? this.textures.map ?? null;
    u.nightMap.value = this.textures.night ?? this.textures.map ?? null;
    u.nightOnly.value = this.style === 'night' ? 1 : 0;
    u.realLight.value = this.realLight ? 1 : 0;
    const map = this.style === 'map';
    this.borderMat.color.set(map ? 0xcf86a3 : 0xffffff);
    this.borderMat.opacity = map ? 0.95 : 0.4;
    this.coastMat.color.set(map ? 0x86b9de : 0xcfe3ff);
    this.coastMat.opacity = map ? 0.75 : this.style === 'night' ? 0.22 : 0.3;
    const dark = !map || this.realLight;
    this.provMat.color.set(dark ? 0xffffff : 0xb48ca8);
    this.provMat.opacity = dark ? 0.35 : 0.75;
    this.roadMat.opacity = dark ? 0.6 : 0.9;
    for (const l of this.labels) this.paintLabel(l, dark);
    this.cityDark = dark;
    this.requestRender();
  }

  private paintLabel(l: Label, dark: boolean): void {
    const halo = dark
      ? '0 0 2px #000, 0 0 4px #000, 0 0 6px rgba(0,0,0,.85)'
      : '0 0 2px #fff, 0 0 3px #fff, 0 0 5px #fff';
    const s = l.el.style;
    s.color = dark ? '#f3f6fc' : '#333a44';
    s.textShadow = halo;
    s.fontStyle = 'normal';
    s.letterSpacing = '0';
    if (l.kind === 'continent') {
      s.font = `600 15px ${FONT}`;
      s.letterSpacing = '.3em';
      if (!dark) s.color = '#7b828c';
    } else if (l.kind === 'ocean') {
      s.font = `400 14px ${FONT}`;
      s.fontStyle = 'italic';
      s.letterSpacing = '.28em';
      s.color = dark ? '#a9cdfa' : '#4d87c2';
      if (!dark) s.textShadow = 'none';
    }
  }

  private describe(latDeg: number, lonDeg: number): EarthPlace {
    const found = nearestCity(this.cities, latDeg, lonDeg, PICK_CITY_KM);
    let country = this.ids ? countryAt(this.ids, this.byId, latDeg, lonDeg) : undefined;
    if (!country && found && found.distKm <= COAST_SLACK_KM)
      country = this.countryList.find((c) => c.name === found.city.country);
    return { latDeg, lonDeg, country, city: found?.city, cityDistKm: found?.distKm };
  }

  private draw(): void {
    const D = this.camera.position.length();
    // Keep the clip planes tight around the globe so the lines hovering 0.05% above it do not flicker.
    this.camera.near = Math.max(0.0008, (D - 1) * 0.4);
    this.camera.far = D + 2;
    this.camera.updateProjectionMatrix();
    this.controls.rotateSpeed = clamp((D - 1) * 0.55, 0.04, 0.9);
    // A fixed share of the view: the marker's size follows the camera's height above the ground.
    this.marker.scale.setScalar(Math.max(0.00015, (D - 1) * 0.004));
    if (D < 1.9) void this.loadDetail();
    this.renderer.render(this.scene, this.camera);
    this.placeLabels(D);
  }

  private placeLabels(D: number): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    const cam = this.dirs.camera.copy(this.camera.position).normalize();
    const p = this.dirs.tmp;
    const maxRank = D > 4.2 ? 16 : D > 3.3 ? 32 : D > 2.6 ? 64 : D > 2 ? 115 : D > 1.65 ? 185 : 400;
    // A label is on the near side when its direction is within the horizon angle of the camera's, plus a margin.
    const limit = 1 / D + 0.06;
    const taken: [number, number, number, number][] = [];
    const selected = this.labels.filter((l) => l.countryId === this.selectedId && this.selectedId >= 0);
    const order = [...selected, ...this.labels.filter((l) => !selected.includes(l))];
    for (const l of order) {
      const isSelected = selected.includes(l);
      let ok =
        isSelected || (l.kind === 'country' ? l.rank <= maxRank : l.kind === 'continent' ? D > 1.8 && D < 7 : D > 1.45);
      if (ok) ok = l.dir.dot(cam) > limit;
      let x = 0;
      let y = 0;
      if (ok) {
        p.copy(l.dir).project(this.camera);
        x = (p.x * 0.5 + 0.5) * w;
        y = (-p.y * 0.5 + 0.5) * h - (isSelected && this.placed ? 17 : 0);
        ok = x > -40 && x < w + 40 && y > -20 && y < h + 20;
      }
      if (ok) {
        const box: [number, number, number, number] = [
          x - l.widthPx / 2,
          y - l.heightPx / 2,
          x + l.widthPx / 2,
          y + l.heightPx / 2,
        ];
        ok = !taken.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1]);
        if (ok) taken.push(box);
      }
      l.el.style.display = ok ? '' : 'none';
      if (ok) l.el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) translate(-50%,-50%)`;
    }
    this.placeCities(D, cam, taken);
  }

  private placeCities(D: number, cam: THREE.Vector3, taken: [number, number, number, number][]): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    const p = this.dirs.tmp;
    let used = 0;
    if (this.cities.length && D < 2.4) {
      const maxZoomLevel =
        D > 2.1 ? 2.6 : D > 1.75 ? 3.6 : D > 1.45 ? 4.6 : D > 1.28 ? 5.6 : D > 1.14 ? 6.6 : D > 1.06 ? 7.6 : 10;
      const limit = 1 / D + 0.005;
      for (const c of this.cities) {
        if (c.zoomLevel > maxZoomLevel || used >= this.cityPool.length) break;
        p.set(...lonLatToScene(c.latDeg, c.lonDeg));
        if (p.dot(cam) < limit) continue;
        p.project(this.camera);
        const x = (p.x * 0.5 + 0.5) * w;
        const y = (-p.y * 0.5 + 0.5) * h;
        if (x < -40 || x > w + 40 || y < -10 || y > h + 10) continue;
        const box: [number, number, number, number] = [x - 5, y - 8, x - 5 + c.name.length * 6.6 + 16, y + 8];
        if (taken.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1])) continue;
        taken.push(box);
        this.showCity(this.cityPool[used++], c, x, y);
      }
    }
    for (let i = used; i < this.cityPool.length; i++) this.cityPool[i].el.style.display = 'none';
  }

  private showCity(label: CityLabel, c: EarthCity, x: number, y: number): void {
    const capital = c.capital === 2;
    const dark = this.cityDark;
    const s = label.el.style;
    s.display = '';
    s.transform = `translate(${(x - 5).toFixed(1)}px,${(y - 8).toFixed(1)}px)`;
    s.font = `${capital ? 600 : 500} ${capital ? 12.5 : 11.5}px ${FONT}`;
    s.color = dark ? '#f3f6fc' : '#232a33';
    s.textShadow = dark ? '0 0 2px #000, 0 0 4px #000' : '0 0 2px #fff, 0 0 3px #fff, 0 0 5px #fff';
    if (label.text.data !== c.name) label.text.data = c.name;
    const size = capital ? '7px' : '5px';
    Object.assign(label.dot.style, {
      width: size,
      height: size,
      background: capital ? '#fff' : '#3b4452',
      borderColor: capital ? '#3b4452' : '#fff',
    });
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
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
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
    void this.loadDetail().then(() => {
      if (this.disposed) return;
      this.opts.onPick?.(this.describe(latDeg, lonDeg));
      // Up close the map follows the click, as a flat map does; from far away the globe stays put.
      const D = this.camera.position.length();
      if (D < 2.2) void this.flyTo(latDeg, lonDeg, D, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 500);
    });
  };
}
