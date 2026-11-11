import { KM_PER_AU, PLANET_NAMES, type PlanetName, type SolarBodyKey, type Vec3 } from '@siteline/physics';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** Everything the overview draws; the Sun is fixed at the origin. */
export type SolarLabelKey = SolarBodyKey | 'sun';

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
}

// Sizes are for looking at, not to scale: the real Sun is 109 Earths wide.
const LOOK: Record<SolarLabelKey, { size: number; color: number }> = {
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
const MOON_ORBIT_SCENE = 1.25;
const ORBIT_COLOR = 0x3a4656;

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

export class SolarView {
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.05, 6000);
  private readonly controls: OrbitControls;
  private readonly meshes = new Map<SolarLabelKey, THREE.Mesh>();
  private readonly labelLayer = document.createElement('div');
  private readonly labels = new Map<SolarLabelKey, HTMLElement>();
  private readonly orbitLines = new THREE.Group();
  private readonly glow = glowTexture();
  private readonly textures: THREE.Texture[] = [this.glow];
  private readonly resize: ResizeObserver;
  private flying = false;
  private frame = 0;

  constructor(
    private readonly container: HTMLElement,
    private readonly opts: SolarViewOptions,
  ) {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x05070a);

    // Far enough back that Neptune's orbit (radius about 77) fits in the frame.
    this.camera.position.set(0, 150, 215);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.minDistance = 2;
    this.controls.maxDistance = 400;
    this.controls.addEventListener('change', () => this.requestRender());

    const light = new THREE.PointLight(0xffffff, 3, 0, 0);
    this.scene.add(light, new THREE.AmbientLight(0x8090b0, 0.08), this.orbitLines, this.stars());
    for (const key of Object.keys(LOOK) as SolarLabelKey[]) this.addBody(key);

    Object.assign(this.labelLayer.style, {
      position: 'absolute',
      inset: '0',
      overflow: 'hidden',
      pointerEvents: 'none',
    });
    container.appendChild(this.labelLayer);
    for (const key of Object.keys(LOOK) as SolarLabelKey[]) this.addLabel(key);

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(container);
    this.fit();
  }

  /** One orbit per planet, as x, y, z triples in km. */
  setOrbits(orbits: Record<PlanetName, Float32Array>): void {
    for (const child of [...this.orbitLines.children]) {
      this.orbitLines.remove(child);
      (child as THREE.LineLoop).geometry.dispose();
    }
    const material = new THREE.LineBasicMaterial({ color: ORBIT_COLOR });
    const p = new THREE.Vector3();
    for (const name of PLANET_NAMES) {
      const km = orbits[name];
      const points: THREE.Vector3[] = [];
      for (let i = 0; i < km.length; i += 3) points.push(toScene([km[i], km[i + 1], km[i + 2]], p).clone());
      this.orbitLines.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), material));
    }
    this.requestRender();
  }

  setSnapshot(s: SolarSnapshot): void {
    for (const name of PLANET_NAMES) toScene(s.positionsKm[name], this.mesh(name).position);
    const earth = this.mesh('earth').position;
    const away = toScene(s.positionsKm.moon).normalize();
    this.mesh('moon').position.copy(earth).addScaledVector(away, MOON_ORBIT_SCENE);
    this.requestRender();
  }

  /** Dive toward a body until it fills the view; resolves on arrival. */
  flyTo(body: SolarBodyKey, durationMs = 1800): Promise<void> {
    const target = this.mesh(body).position.clone();
    const size = LOOK[body].size;
    // Approach from the side facing the camera, so the body never swings out of view.
    const from = this.camera.position.clone().sub(target).normalize();
    const endPos = target.clone().addScaledVector(from, Math.max(size * 5, 1.2));
    const startPos = this.camera.position.clone();
    const startTarget = this.controls.target.clone();
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

  dispose(): void {
    cancelAnimationFrame(this.frame);
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
    const url = key === 'sun' ? undefined : this.opts.textures?.[key];
    if (url) {
      new THREE.TextureLoader().load(url, (map) => {
        map.colorSpace = THREE.SRGBColorSpace;
        this.textures.push(map);
        material.map = map;
        material.color.set(0xffffff);
        material.needsUpdate = true;
        this.requestRender();
      });
    }
    // The Sun gets a bright core and a wide faint bloom; each planet a faint halo in its own colour.
    if (key === 'sun') {
      mesh.add(this.halo(0xffe2a0, size * 4, 1), this.halo(0xffa040, size * 10, 0.45));
    } else mesh.add(this.halo(color, size * 3.6, 0.55));
    if (key === 'saturn') {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(size * 1.35, size * 2.2, 64),
        new THREE.MeshBasicMaterial({ color: 0xcdbb8c, side: THREE.DoubleSide, transparent: true, opacity: 0.55 }),
      );
      ring.rotation.x = Math.PI / 2 - 0.47;
      mesh.add(ring);
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
    });
    if (go) {
      (el as HTMLButtonElement).type = 'button';
      el.addEventListener('click', () => this.opts.onSelect?.(key as SolarBodyKey));
    }
    this.labels.set(key, el);
    this.labelLayer.appendChild(el);
  }

  private stars(): THREE.Points {
    const n = 1600;
    const pos = new Float32Array(n * 3);
    // A fixed seed keeps the sky identical on every load.
    let s = 12345;
    const rand = () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
    for (let i = 0; i < n; i++) {
      const z = 2 * rand() - 1;
      const a = 2 * Math.PI * rand();
      const r = Math.sqrt(1 - z * z);
      pos.set([1800 * r * Math.cos(a), 1800 * z, 1800 * r * Math.sin(a)], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false }));
  }

  private draw(): void {
    this.renderer.render(this.scene, this.camera);
    const { clientWidth: w, clientHeight: h } = this.container;
    const p = new THREE.Vector3();
    for (const [key, el] of this.labels) {
      p.copy(this.mesh(key).position).project(this.camera);
      const visible = p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1;
      el.style.display = visible ? '' : 'none';
      if (!visible) continue;
      el.style.left = `${((p.x + 1) / 2) * w}px`;
      // The Moon sits beside the Earth, so its label goes above and the Earth's below.
      const offset = key === 'moon' ? -(LOOK[key].size * 6 + 34) : LOOK[key].size * 6 + 6;
      el.style.top = `${((1 - p.y) / 2) * h + offset}px`;
    }
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
}
