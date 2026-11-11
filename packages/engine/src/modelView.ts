import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/** The lander models are stored as JSON holding one base64 string of the binary glTF (`.glb`). */
const files = new Map<string, Promise<ArrayBuffer>>();

function fetchGlb(url: string): Promise<ArrayBuffer> {
  let file = files.get(url);
  if (!file) {
    file = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`${url}: ${r.status}`);
        return r.json() as Promise<{ b64: string }>;
      })
      .then(({ b64 }) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer);
    files.set(url, file);
    file.catch(() => files.delete(url));
  }
  return file;
}

/** Where the Sun is at the lander: height above the horizon and compass bearing, both in degrees. */
export interface ModelSun {
  heightDeg: number;
  azimuthDeg: number;
}

const DEG = Math.PI / 180;
const FIT = 2.2;

/** A small turntable that shows one NASA 3D model standing on the ground, lit from where the Sun is at its site. */
export class ModelView {
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(32, 1, 0.05, 100);
  private readonly controls: OrbitControls;
  private readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  private readonly sky = new THREE.HemisphereLight(0xbfcfff, 0x2a2420, 0.35);
  private readonly ground = new THREE.Mesh(
    new THREE.CircleGeometry(3.2, 64),
    new THREE.MeshStandardMaterial({ color: 0x8a8a86, roughness: 1 }),
  );
  private readonly holder = new THREE.Group();
  private readonly resize: ResizeObserver;
  private readonly still: boolean;
  private shown?: string;
  private frame = 0;
  private disposed = false;

  constructor(private readonly container: HTMLElement) {
    this.still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.ground.rotation.x = -Math.PI / 2;
    this.scene.add(this.sun, this.sky, this.ground, this.holder);
    this.camera.position.set(4.2, 2.4, 4.6);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = !this.still;
    this.controls.autoRotate = !this.still;
    this.controls.autoRotateSpeed = 0.8;
    this.controls.enablePan = false;
    this.controls.minDistance = 2.5;
    this.controls.maxDistance = 14;
    this.controls.target.set(0, 0.8, 0);
    this.controls.addEventListener('change', () => this.requestRender());
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(container);
    this.fit();
    if (!this.still) this.loop();
  }

  /** Stand a model on the ground; resolves when it is in the scene, rejects if it cannot be read. */
  async show(url: string): Promise<void> {
    if (this.shown === url) return;
    const buffer = await fetchGlb(url);
    const gltf = await new Promise<{ scene: THREE.Object3D }>((resolve, reject) =>
      new GLTFLoader().parse(buffer.slice(0), '', resolve, reject),
    );
    if (this.disposed) return;
    const model = gltf.scene;
    const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
    model.scale.setScalar(FIT / Math.max(size.x, size.y, size.z));
    const box = new THREE.Box3().setFromObject(model);
    const centre = box.getCenter(new THREE.Vector3());
    model.position.set(-centre.x, -box.min.y, -centre.z);
    this.holder.clear();
    this.holder.add(model);
    this.shown = url;
    this.requestRender();
  }

  /** Light the model as the Sun lights its site, and tint the ground for the planet. */
  setLight(sun: ModelSun, ground: 'Moon' | 'Mars'): void {
    const el = sun.heightDeg * DEG;
    const az = sun.azimuthDeg * DEG;
    const night = sun.heightDeg < 0;
    this.sun.position.set(
      Math.sin(az) * Math.cos(el) * 10,
      Math.max(0.05, Math.sin(el)) * 10,
      -Math.cos(az) * Math.cos(el) * 10,
    );
    this.sun.intensity = night ? 0 : 3.2;
    this.sky.intensity = night ? 0.12 : 0.45;
    (this.ground.material as THREE.MeshStandardMaterial).color.set(ground === 'Mars' ? 0xa86a45 : 0x8a8a86);
    this.requestRender();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.controls.dispose();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
          m.dispose();
        }
      }
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private loop = () => {
    if (this.disposed) return;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.frame = requestAnimationFrame(this.loop);
  };

  private requestRender(): void {
    if (!this.still || this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
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
