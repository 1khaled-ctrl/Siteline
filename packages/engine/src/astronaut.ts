import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GaitPose } from './astronautGait';

/**
 * The astronaut you are in Land Here: jgilhutton's rigged EMU suit (Blend Swap 73994, CC BY 3.0), exported by
 * `assets/export_astronaut.py`. Seen from the eye, so the helmet and the chest pack are hidden: look down for the arms
 * and the boots. The joints follow `gaitPose`; nothing else about the suit is simulated.
 */
export const ASTRONAUT_URL = new URL('../assets/astronaut.glb', import.meta.url).href;

/**
 * A node's name as exported: three.js drops dots and turns spaces into underscores ("thigh.L" is "thighL"), and adds
 * "_1" and so on where two nodes share a name (the helmet's mesh and its bone are both "Casco").
 */
const baseName = (name: string) => name.replace(/_\d+$/, '');

/** The helmet's meshes, hidden: the eye is inside it. */
const HELMET = new Set(['Casco', 'Cubre_todo', 'Lamparas', 'Parasol', 'Parasol_costado', 'Vidrio_(Glass)']);
/** How far down from level the arms hang when standing, degrees (the suit holds them a little away from the body). */
const ARM_HANG_DEG = 72;
/**
 * How far in front of the helmet's bone (its middle) the eye is put, metres. Further forward than a face in a helmet:
 * from a real eye the suit hides your boots, and here they show past the chest when you look down.
 */
const EYE_FORWARD_M = 0.35;
/** The bone the chest pack (the display and control module) hangs from: hidden too, as it would block the view down. */
const CHEST_PACK_BONE = 'Bone001';

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

/** A rotation about one of the model's axes. In the model, +Z is forward, +X is the astronaut's left, +Y is up. */
const about = (axis: THREE.Vector3, rad: number) => new THREE.Quaternion().setFromAxisAngle(axis, rad);

interface Joint {
  bone: THREE.Bone;
  /** The bone's orientation in the model at rest, and its parent's (the parent stays at rest unless it is a joint). */
  restWorld: THREE.Quaternion;
  parentRestWorld: THREE.Quaternion;
  parent?: Joint;
  /** The model-space rotation this pose gives the bone, from its own joint or carried down from its parent's. */
  turn: THREE.Quaternion;
}

export class AstronautBody {
  /** Placed at the feet, turned to face where the eye looks. */
  readonly root = new THREE.Group();
  private readonly joints: Joint[] = [];
  private readonly byName = new Map<string, Joint>();
  /** The eye in the model: forward and up from the feet, metres. */
  private readonly eyeForwardM: number;
  private readonly soleUpM: number;
  /** How far each upper arm must turn down to hang (left, right), radians. */
  private readonly hangRad: [number, number];
  private readonly materials = new Set<THREE.Material>();
  private readonly tmp = new THREE.Quaternion();

  private constructor(model: THREE.Object3D) {
    this.root.name = 'astronaut';
    this.root.add(model);
    model.updateMatrixWorld(true);
    const box = new THREE.Box3();
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (HELMET.has(baseName(o.name)) && !(o as THREE.Bone).isBone) o.visible = false;
      if ((o as THREE.Bone).isBone && baseName(o.name) === CHEST_PACK_BONE) {
        for (const c of o.children) if (!(c as THREE.Bone).isBone) c.visible = false;
      }
      if (!mesh.isMesh) return;
      // Skinned bounds are the rest pose's; close to the eye a limb must never be culled as it swings out of them.
      mesh.frustumCulled = false;
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of list) this.materials.add(m);
      if (o.visible && !hiddenAbove(o)) box.expandByObject(mesh);
    });
    this.soleUpM = box.isEmpty() ? 0 : box.min.y;

    const bones: THREE.Bone[] = [];
    model.traverse((o) => {
      if ((o as THREE.Bone).isBone) bones.push(o as THREE.Bone);
    });
    for (const bone of bones) {
      const parent =
        bone.parent && (bone.parent as THREE.Bone).isBone ? this.joints.find((j) => j.bone === bone.parent) : undefined;
      const joint: Joint = {
        bone,
        restWorld: bone.getWorldQuaternion(new THREE.Quaternion()),
        parentRestWorld: bone.parent ? bone.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion(),
        parent,
        turn: new THREE.Quaternion(),
      };
      this.joints.push(joint);
      if (!this.byName.has(baseName(bone.name))) this.byName.set(baseName(bone.name), joint);
    }

    const at = (name: string) => this.byName.get(name)?.bone.getWorldPosition(new THREE.Vector3());
    const helmet = at('Casco');
    this.eyeForwardM = (helmet?.z ?? 0) + EYE_FORWARD_M;
    this.hangRad = (['L', 'R'] as const).map((side) => {
      const shoulder = at(`upper_arm${side}`);
      const elbow = at(`forearm${side}`);
      if (!shoulder || !elbow) return 0;
      const below = Math.atan2(shoulder.y - elbow.y, Math.abs(elbow.x - shoulder.x));
      return (ARM_HANG_DEG * Math.PI) / 180 - below;
    }) as [number, number];
  }

  /** Loads the suit; rejects if the file cannot be read. */
  static async load(url = ASTRONAUT_URL): Promise<AstronautBody> {
    const gltf = await new GLTFLoader().loadAsync(url);
    return new AstronautBody(gltf.scene);
  }

  /**
   * Stand the body on the ground under the eye, facing `headingRad` (clockwise from north, the camera's heading). The
   * scene's axes are east = +x, north = −z, up = +y, as in the surface view.
   */
  place(east: number, north: number, groundUpM: number, headingRad: number): void {
    // The model faces +Z; the camera at heading 0 faces −Z (north) and turns clockwise as the heading grows.
    const yaw = Math.PI - headingRad;
    this.root.rotation.set(0, yaw, 0);
    // Put the eye's place in the helmet straight over the eye, and the boots on the ground.
    const back = this.eyeForwardM;
    this.root.position.set(east - Math.sin(yaw) * back, groundUpM - this.soleUpM, -north - Math.cos(yaw) * back);
  }

  /** Turn the joints to a pose. */
  pose(g: GaitPose): void {
    for (const j of this.joints) j.turn.copy(j.parent ? j.parent.turn : this.tmp.identity());
    const set = (name: string, q: THREE.Quaternion) => this.byName.get(name)?.turn.copy(q);
    set('hips', about(Y, g.hipTurnRad));
    set('spine', about(Y, -0.3 * g.hipTurnRad));
    const chest = about(Y, -0.6 * g.hipTurnRad);
    set('chest', chest);
    (['L', 'R'] as const).forEach((side, i) => {
      // Legs: a forward swing turns the foot toward +Z, about +X by a negative angle; a bent knee takes it back.
      const thigh = -g.thighRad[i];
      set(`thigh${side}`, about(X, thigh));
      set(`shin${side}`, about(X, thigh + g.kneeRad[i]));
      set(`foot${side}`, about(X, thigh + g.kneeRad[i] - g.ankleRad[i]));
      // Arms: hang them down from the rest pose (about the forward axis), then swing and bend them about +X.
      const hang = about(Z, side === 'L' ? -this.hangRad[0] : this.hangRad[1]);
      const swing = about(X, -g.upperArmRad[i]);
      const upper = chest.clone().multiply(swing).multiply(hang);
      set(`upper_arm${side}`, upper);
      // The forearm bends forward at the elbow, then turns in toward the body (left turns toward −X, right toward +X).
      const inward = about(Y, side === 'L' ? -g.forearmInRad : g.forearmInRad);
      set(
        `forearm${side}`,
        chest.clone().multiply(swing).multiply(inward).multiply(about(X, -g.elbowRad[i])).multiply(hang),
      );
    });
    // Each bone's turn applies in the model: its posed orientation is turn × rest, and its local rotation is that
    // against its parent's posed orientation.
    const posed = new Map<THREE.Bone, THREE.Quaternion>();
    for (const j of this.joints) {
      const world = j.turn.clone().multiply(j.restWorld);
      posed.set(j.bone, world);
      const parentWorld = j.parent ? (posed.get(j.parent.bone) as THREE.Quaternion) : j.parentRestWorld;
      j.bone.quaternion.copy(parentWorld.clone().invert().multiply(world));
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
    for (const m of this.materials) {
      for (const value of Object.values(m)) if (value instanceof THREE.Texture) value.dispose();
      m.dispose();
    }
  }
}

/** Whether an object sits under a hidden one (a helmet part's children). */
function hiddenAbove(o: THREE.Object3D): boolean {
  for (let p = o.parent; p; p = p.parent) if (!p.visible) return true;
  return false;
}
