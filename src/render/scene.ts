import * as THREE from "three";
import { CONFIG, type TaskId } from "../config";
import { BODY_SPECS, RENDER_BODIES } from "../sim/spec";
import { MUSCLE_VIEW_SIZE } from "../sim/muscles";
import { PROP_COUNT, PROP_STRIDE } from "../sim/tasks";
import type { BagSpec, Structure } from "../sim/course";
import { terrainY, type Piece } from "../sim/terrain";

/**
 * ============================================================
 *  ESCENA 3D: cuerpo, músculos, escenarios y objetos dinámicos
 * ============================================================
 * Además de las poses, el worker manda activación/fatiga por segmento
 * (los músculos se hinchan y enrojecen) y las transformaciones del saco,
 * la cuerda y las pesas/guantes.
 */

export interface FrameData {
  tr: Float32Array;
  mus: Float32Array; // n × MUSCLE_VIEW_SIZE
  props: Float32Array; // n × PROP_COUNT × PROP_STRIDE
  look: Uint8Array;
  lane: Float32Array;
  cur: Float32Array;
  focus: number;
  assist: number;
  n: number;
  task: TaskId;
  ctxSize: number;
}

export const CAMERA_MODES = [
  { name: "Atrás", yaw: Math.PI, pitch: 0.32, dist: 5.2 },
  { name: "Lateral", yaw: Math.PI / 2, pitch: 0.18, dist: 4.6 },
  { name: "Frente", yaw: 0.55, pitch: 0.3, dist: 5.0 },
  { name: "Aérea", yaw: Math.PI, pitch: 1.3, dist: 9 },
];

const LOOK_COLORS = [0x4f8fd6, 0x4ade80, 0xfbbf24, 0x6b7280, 0x22d3ee, 0xc084fc];
const R = RENDER_BODIES.length;

interface AgentView {
  group: THREE.Group;
  structures: THREE.Group;
  propsGroup: THREE.Group;
  meshes: THREE.Mesh[];
  muscleMeshes: THREE.Mesh[];
  muscleMats: THREE.MeshLambertMaterial[];
  harness: THREE.Mesh;
  bag: THREE.Mesh | null;
  rope: THREE.Mesh | null;
  hands: THREE.Object3D[];
  look: number;
}

export class Scene3D {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400);
  private agents: AgentView[] = [];
  private geoms: THREE.BufferGeometry[] = [];
  private mats: THREE.MeshLambertMaterial[][] = [];
  private harnessMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, depthWrite: false });
  private harnessGeo = new THREE.CylinderGeometry(0.012, 0.012, 1, 4);
  private terrainMesh: THREE.Mesh | null = null;
  private pitMesh: THREE.Mesh | null = null;
  private terrainMat: THREE.MeshLambertMaterial;
  private pitMat = new THREE.MeshLambertMaterial({ color: 0x0f172a, side: THREE.DoubleSide });
  private labels: THREE.Sprite[] = [];
  private sun: THREE.DirectionalLight;
  private target = new THREE.Vector3(0, 1, 0);
  private view = { yaw: Math.PI, pitch: 0.32, dist: 5.2 };
  private goal = { yaw: Math.PI, pitch: 0.32, dist: 5.2 };
  private mode = 0;
  private quality = 0;
  private mobile: boolean;
  private shake = 0;

  private structures: Structure[] = [];
  private bagSpec: BagSpec | null = null;
  private propKind: "none" | "weight" | "glove" = "none";
  private staticGeoms: THREE.BufferGeometry[] = [];
  private staticMats: THREE.Material[] = [];
  private propGeoms: THREE.BufferGeometry[] = [];
  private propMats: THREE.Material[] = [];
  private bagGeo!: THREE.BufferGeometry;
  private ropeGeo!: THREE.BufferGeometry;
  private barGeo!: THREE.BufferGeometry;
  private plateGeo!: THREE.BufferGeometry;
  private gloveGeo!: THREE.BufferGeometry;
  private bagMat!: THREE.MeshLambertMaterial;
  private ropeMat!: THREE.MeshLambertMaterial;
  private handMat!: THREE.MeshLambertMaterial;
  private gloveMat!: THREE.MeshLambertMaterial;

  private relax = new THREE.Color(0x3b82f6);
  private active = new THREE.Color(0xef4444);
  private tired = new THREE.Color(0xa855f7);
  private tmpColor = new THREE.Color();
  private up = new THREE.Vector3(0, 1, 0);
  private vA = new THREE.Vector3();
  private vB = new THREE.Vector3();
  private vDir = new THREE.Vector3();
  private vMid = new THREE.Vector3();

  constructor(private canvas: HTMLCanvasElement, mobile: boolean) {
    this.mobile = mobile;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !mobile, powerPreference: "high-performance" });
    this.renderer.setClearColor(0x9fd0f5);
    this.scene.fog = new THREE.Fog(0xb9dcf7, 22, 95);
    this.scene.add(new THREE.HemisphereLight(0xdff1ff, 0x6a7a55, 1.05));
    this.sun = new THREE.DirectionalLight(0xffffff, 1.6);
    this.sun.position.set(6, 14, 8);
    this.sun.castShadow = false;
    this.sun.shadow.mapSize.set(1024, 1024);
    const sc = this.sun.shadow.camera;
    sc.left = -9; sc.right = 9; sc.top = 9; sc.bottom = -9; sc.near = 1; sc.far = 40;
    this.scene.add(this.sun, this.sun.target);

    const void_ = new THREE.Mesh(new THREE.PlaneGeometry(800, 800), new THREE.MeshLambertMaterial({ color: 0x5b7a52 }));
    void_.rotation.x = -Math.PI / 2;
    void_.position.set(100, -5, 0);
    this.scene.add(void_);

    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    g.fillStyle = "#8fbf6a"; g.fillRect(0, 0, 64, 64);
    g.fillStyle = "#7aac58"; g.fillRect(0, 0, 32, 32); g.fillRect(32, 32, 32, 32);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.NearestFilter;
    tex.anisotropy = 4;
    this.terrainMat = new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide });

    LOOK_COLORS.forEach((col) => {
      const base = new THREE.MeshLambertMaterial({ color: col });
      const dark = new THREE.MeshLambertMaterial({ color: new THREE.Color(col).multiplyScalar(0.55) });
      this.mats.push([base, dark]);
    });
    for (const i of RENDER_BODIES) {
      const b = BODY_SPECS[i];
      let geo: THREE.BufferGeometry;
      if (b.shape === "box") geo = new THREE.BoxGeometry(b.size[0] * 2, b.size[1] * 2, b.size[2] * 2);
      else if (b.shape === "capsule") geo = new THREE.CapsuleGeometry(b.size[1], b.size[0] * 2, 3, 8);
      else geo = new THREE.SphereGeometry(b.size[0], 12, 8);
      this.geoms.push(geo);
    }
    for (let d = 10; d <= 130; d += 10) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.labelTexture(`${d} m`), depthWrite: false, fog: false }));
      sp.scale.set(2.4, 1.2, 1);
      sp.userData.x = d;
      this.labels.push(sp);
      this.scene.add(sp);
    }
    this.buildSharedAssets();
    this.setQuality(0);
    this.setCameraMode(0);
  }

  private labelTexture(text: string) {
    const c = document.createElement("canvas");
    c.width = 256; c.height = 128;
    const g = c.getContext("2d")!;
    g.fillStyle = "rgba(15,23,42,0.55)";
    g.beginPath(); g.roundRect(8, 24, 240, 80, 24); g.fill();
    g.fillStyle = "#fff"; g.font = "bold 56px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(text, 128, 66);
    return new THREE.CanvasTexture(c);
  }

  // ------------------------------------------------------------ calidad
  setQuality(level: number) {
    this.quality = level;
    const dpr = window.devicePixelRatio || 1;
    const caps = this.mobile ? [1.5, 1.25, 1, 0.75] : [2, 1.5, 1.25, 1];
    this.renderer.setPixelRatio(Math.min(dpr, caps[Math.min(level, 3)]));
    const shadows = !this.mobile && level === 0;
    this.renderer.shadowMap.enabled = shadows;
    this.sun.castShadow = shadows;
    this.resize();
    for (const a of this.agents) {
      for (const m of a.meshes) m.castShadow = shadows;
      for (const m of a.muscleMeshes) m.castShadow = false;
    }
    if (this.terrainMesh) this.terrainMesh.receiveShadow = shadows;
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) m.needsUpdate = true;
    });
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w / h < 0.8 ? 68 : 55;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------ escenario
  private disposeShared() {
    for (const g of this.staticGeoms) g.dispose();
    for (const m of this.staticMats) m.dispose();
    for (const g of this.propGeoms) g.dispose();
    for (const m of this.propMats) m.dispose();
    this.staticGeoms = [];
    this.staticMats = [];
    this.propGeoms = [];
    this.propMats = [];
  }

  private buildSharedAssets() {
    for (const st of this.structures) {
      let geo: THREE.BufferGeometry;
      if (st.kind === "box") geo = new THREE.BoxGeometry(st.size[0] * 2, st.size[1] * 2, st.size[2] * 2);
      else if (st.kind === "sphere") geo = new THREE.SphereGeometry(st.size[0], 14, 10);
      else geo = new THREE.CylinderGeometry(st.size[0], st.size[0], st.size[1] * 2, 12);
      const mat = new THREE.MeshLambertMaterial({
        color: st.color,
        transparent: (st.opacity ?? 1) < 1,
        opacity: st.opacity ?? 1,
        side: THREE.DoubleSide,
        depthWrite: (st.opacity ?? 1) >= 1,
      });
      this.staticGeoms.push(geo);
      this.staticMats.push(mat);
    }
    const radius = this.bagSpec?.radius ?? 0.22;
    const half = this.bagSpec?.halfHeight ?? 0.42;
    this.bagGeo = new THREE.CapsuleGeometry(radius, half * 2, 4, 12);
    this.ropeGeo = new THREE.CylinderGeometry(0.012, 0.012, 1, 6);
    this.barGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.22, 8);
    this.plateGeo = new THREE.CylinderGeometry(0.055, 0.055, 0.035, 10);
    this.gloveGeo = new THREE.BoxGeometry(0.14, 0.1, 0.12);
    this.bagMat = new THREE.MeshLambertMaterial({ color: 0xb91c1c });
    this.ropeMat = new THREE.MeshLambertMaterial({ color: 0x334155 });
    this.handMat = new THREE.MeshLambertMaterial({ color: 0x1e293b });
    this.gloveMat = new THREE.MeshLambertMaterial({ color: 0xef4444 });
    this.propGeoms.push(this.bagGeo, this.ropeGeo, this.barGeo, this.plateGeo, this.gloveGeo);
    this.propMats.push(this.bagMat, this.ropeMat, this.handMat, this.gloveMat);
  }

  setProfile(pieces: Piece[], structures: Structure[], task: TaskId, bag: BagSpec | null, propKind: "none" | "weight" | "glove") {
    this.structures = structures;
    this.bagSpec = bag;
    this.propKind = propKind;
    if (this.terrainMesh) {
      this.scene.remove(this.terrainMesh);
      this.terrainMesh.geometry.dispose();
      this.terrainMesh = null;
    }
    if (this.pitMesh) {
      this.scene.remove(this.pitMesh);
      this.pitMesh.geometry.dispose();
      this.pitMesh = null;
    }
    this.disposeShared();
    this.buildSharedAssets();

    const hw = CONFIG.terrainHalfWidth;
    const pos: number[] = [], uv: number[] = [], pit: number[] = [];
    const quad = (a: number[], b: number[], c: number[], d: number[]) => {
      for (const v of [a, b, c, a, c, d]) pos.push(v[0], v[1], v[2]);
    };
    const pitQuad = (a: number[], b: number[], c: number[], d: number[]) => {
      for (const v of [a, b, c, a, c, d]) pit.push(v[0], v[1], v[2]);
    };
    const uvQuad = (u: number[][]) => {
      for (const k of [0, 1, 2, 0, 2, 3]) uv.push(u[k][0], u[k][1]);
    };
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      if (p.hole) {
        const yb = -1.6;
        pitQuad([p.x0, yb, hw], [p.x1, yb, hw], [p.x1, yb, -hw], [p.x0, yb, -hw]);
        pitQuad([p.x0, yb, hw], [p.x0, 0, hw], [p.x0, 0, -hw], [p.x0, yb, -hw]);
        pitQuad([p.x1, 0, hw], [p.x1, yb, hw], [p.x1, yb, -hw], [p.x1, 0, -hw]);
        continue;
      }
      quad([p.x0, p.y0, hw], [p.x1, p.y1, hw], [p.x1, p.y1, -hw], [p.x0, p.y0, -hw]);
      uvQuad([[p.x0 / 2, hw / 2], [p.x1 / 2, hw / 2], [p.x1 / 2, -hw / 2], [p.x0 / 2, -hw / 2]]);
      const nx = pieces[i + 1];
      if (nx && !nx.hole && Math.abs(nx.y0 - p.y1) > 1e-6) {
        const lo = Math.min(p.y1, nx.y0), hi = Math.max(p.y1, nx.y0), x = p.x1;
        if (nx.y0 > p.y1) quad([x, lo, hw], [x, hi, hw], [x, hi, -hw], [x, lo, -hw]);
        else quad([x, hi, -hw], [x, hi, hw], [x, lo, hw], [x, lo, -hw]);
        uvQuad([[0, lo], [0, hi], [hw, hi], [hw, lo]].map(([a, b]) => [a / 2 + x / 2, b * 2]));
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.computeVertexNormals();
    this.terrainMesh = new THREE.Mesh(geo, this.terrainMat);
    this.terrainMesh.receiveShadow = this.renderer.shadowMap.enabled;
    this.scene.add(this.terrainMesh);
    if (pit.length) {
      const pgeo = new THREE.BufferGeometry();
      pgeo.setAttribute("position", new THREE.Float32BufferAttribute(pit, 3));
      pgeo.computeVertexNormals();
      this.pitMesh = new THREE.Mesh(pgeo, this.pitMat);
      this.scene.add(this.pitMesh);
    }
    for (const sp of this.labels) {
      const y = terrainY(pieces, sp.userData.x);
      sp.visible = y > -2;
      sp.position.set(sp.userData.x, y + 3.2, 0);
    }
    for (const a of this.agents) {
      this.rebuildStatic(a);
      this.rebuildProps(a);
    }
    this.setTaskCamera(task);
  }

  private setTaskCamera(task: TaskId) {
    if (task === "climb") this.goal = { yaw: Math.PI / 2, pitch: 0.24, dist: 6.4 };
    else if (task === "boxing") this.goal = { yaw: 0.65, pitch: 0.22, dist: 4.6 };
    else if (task === "parkour") this.goal = { yaw: Math.PI, pitch: 0.28, dist: 6.8 };
    else if (task === "exercise") this.goal = { yaw: Math.PI / 2, pitch: 0.2, dist: 4.7 };
    else this.goal = { yaw: Math.PI, pitch: 0.32, dist: 5.2 };
  }

  private rebuildStatic(a: AgentView) {
    a.structures.clear();
    this.structures.forEach((st, i) => {
      const m = new THREE.Mesh(this.staticGeoms[i], this.staticMats[i]);
      m.position.set(st.pos[0], st.pos[1], st.pos[2]);
      if (st.rotation) m.rotation.set(st.rotation[0], st.rotation[1], st.rotation[2]);
      m.receiveShadow = !!st.solid;
      a.structures.add(m);
    });
  }

  private makeHandProp(): THREE.Group {
    const g = new THREE.Group();
    if (this.propKind === "weight") {
      const bar = new THREE.Mesh(this.barGeo, this.handMat);
      bar.rotation.x = Math.PI / 2;
      g.add(bar);
      for (const z of [-0.095, 0.095]) {
        const plate = new THREE.Mesh(this.plateGeo, this.handMat);
        plate.rotation.x = Math.PI / 2;
        plate.position.z = z;
        g.add(plate);
      }
    } else if (this.propKind === "glove") {
      g.add(new THREE.Mesh(this.gloveGeo, this.gloveMat));
    }
    return g;
  }

  private rebuildProps(a: AgentView) {
    a.propsGroup.clear();
    a.bag = null;
    a.rope = null;
    a.hands = [];
    if (this.bagSpec) {
      a.bag = new THREE.Mesh(this.bagGeo, this.bagMat);
      a.bag.castShadow = this.renderer.shadowMap.enabled;
      a.rope = new THREE.Mesh(this.ropeGeo, this.ropeMat);
      a.propsGroup.add(a.bag, a.rope);
    }
    if (this.propKind !== "none") {
      for (let k = 0; k < 2; k++) {
        const hand = this.makeHandProp();
        a.hands.push(hand);
        a.propsGroup.add(hand);
      }
    }
  }

  // ------------------------------------------------------------ agentes
  private ensureAgents(n: number) {
    while (this.agents.length < n) {
      const group = new THREE.Group();
      const structures = new THREE.Group();
      const propsGroup = new THREE.Group();
      const meshes: THREE.Mesh[] = [];
      const muscleMeshes: THREE.Mesh[] = [];
      const muscleMats: THREE.MeshLambertMaterial[] = [];
      RENDER_BODIES.forEach((bi, k) => {
        const spec = BODY_SPECS[bi];
        const m = new THREE.Mesh(this.geoms[k], this.mats[0][spec.part === "foot" || spec.name === "pelvis" ? 1 : 0]);
        m.castShadow = this.renderer.shadowMap.enabled;
        if (spec.part === "head") {
          const visor = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.14), new THREE.MeshLambertMaterial({ color: 0x0f172a }));
          visor.position.set(0.075, 0.015, 0);
          m.add(visor);
        }
        group.add(m);
        meshes.push(m);
        const mat = new THREE.MeshLambertMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.2, depthWrite: false });
        const mm = new THREE.Mesh(this.geoms[k], mat);
        mm.scale.set(1.08, 1.02, 1.08);
        mm.visible = false;
        group.add(mm);
        muscleMeshes.push(mm);
        muscleMats.push(mat);
      });
      const harness = new THREE.Mesh(this.harnessGeo, this.harnessMat);
      harness.visible = false;
      group.add(harness);
      this.scene.add(group, structures, propsGroup);
      const a: AgentView = { group, structures, propsGroup, meshes, muscleMeshes, muscleMats, harness, bag: null, rope: null, hands: [], look: 0 };
      this.rebuildStatic(a);
      this.rebuildProps(a);
      this.agents.push(a);
    }
    while (this.agents.length > n) {
      const a = this.agents.pop()!;
      this.scene.remove(a.group, a.structures, a.propsGroup);
      for (const m of a.muscleMats) m.dispose();
    }
  }

  setCameraMode(i: number) {
    this.mode = i % CAMERA_MODES.length;
    const m = CAMERA_MODES[this.mode];
    this.goal = { yaw: m.yaw, pitch: m.pitch, dist: m.dist };
    return this.mode;
  }
  get qualityLevel() { return this.quality; }
  get cameraMode() { return this.mode; }
  kick() { this.shake = 0.25; }

  orbit(dx: number, dy: number) {
    this.goal.yaw -= dx * 0.008;
    this.goal.pitch = Math.max(0.03, Math.min(1.45, this.goal.pitch + dy * 0.006));
  }
  zoom(factor: number) {
    this.goal.dist = Math.max(2.2, Math.min(26, this.goal.dist * factor));
  }

  // ------------------------------------------------------------ dibujado
  render(f: FrameData | null, dt: number) {
    if (f) {
      this.ensureAgents(f.n);
      for (let i = 0; i < f.n; i++) {
        const a = this.agents[i];
        a.group.position.z = f.lane[i];
        a.structures.position.z = f.lane[i];
        a.propsGroup.position.z = f.lane[i];
        const l = f.look[i];
        const base = i * R * 7;
        if (a.look !== l) {
          a.look = l;
          RENDER_BODIES.forEach((bi, k) => {
            const spec = BODY_SPECS[bi];
            a.meshes[k].material = this.mats[l][spec.part === "foot" || spec.name === "pelvis" ? 1 : 0];
          });
        }
        for (let k = 0; k < R; k++) {
          const o = base + k * 7;
          const m = a.meshes[k];
          m.position.set(f.tr[o], f.tr[o + 1], f.tr[o + 2]);
          m.quaternion.set(f.tr[o + 3], f.tr[o + 4], f.tr[o + 5], f.tr[o + 6]);
          a.muscleMeshes[k].position.copy(m.position);
          a.muscleMeshes[k].quaternion.copy(m.quaternion);
        }
        if (f.mus && f.mus.length >= (i + 1) * MUSCLE_VIEW_SIZE) {
          const mb = i * MUSCLE_VIEW_SIZE;
          for (let k = 0; k < R; k++) {
            const act = f.mus[mb + k * 2] ?? 0;
            const fatigue = f.mus[mb + k * 2 + 1] ?? 0;
            const mat = a.muscleMats[k];
            const mesh = a.muscleMeshes[k];
            this.tmpColor.copy(this.relax).lerp(this.active, Math.min(1, act)).lerp(this.tired, Math.min(1, fatigue * 0.8));
            mat.color.copy(this.tmpColor);
            mat.opacity = 0.12 + 0.55 * Math.min(1, act);
            const s = 1 + 0.16 * Math.min(1, act);
            mesh.scale.set(s, 1 + 0.03 * Math.min(1, act), s);
            mesh.visible = act > 0.015 || fatigue > 0.02;
          }
        }
        if (f.props && f.props.length >= (i + 1) * PROP_COUNT * PROP_STRIDE) {
          const pb = i * PROP_COUNT * PROP_STRIDE;
          if (a.bag) {
            const vis = f.props[pb + 7] > 0.5;
            a.bag.visible = vis;
            if (vis) {
              a.bag.position.set(f.props[pb], f.props[pb + 1], f.props[pb + 2]);
              a.bag.quaternion.set(f.props[pb + 3], f.props[pb + 4], f.props[pb + 5], f.props[pb + 6]);
            }
          }
          if (a.rope && this.bagSpec) {
            const vis = f.props[pb + 7] > 0.5;
            a.rope.visible = vis;
            if (vis) {
              this.vA.set(this.bagSpec.anchor[0], this.bagSpec.anchor[1], this.bagSpec.anchor[2]);
              this.vB.set(f.props[pb], f.props[pb + 1], f.props[pb + 2]);
              this.vDir.subVectors(this.vB, this.vA);
              const len = this.vDir.length();
              this.vMid.addVectors(this.vA, this.vB).multiplyScalar(0.5);
              a.rope.position.copy(this.vMid);
              a.rope.scale.set(1, Math.max(0.01, len), 1);
              if (len > 1e-4) a.rope.quaternion.setFromUnitVectors(this.up, this.vDir.normalize());
            }
          }
          for (let k = 0; k < a.hands.length; k++) {
            const o = pb + (1 + k) * PROP_STRIDE;
            const vis = f.props[o + 7] > 0.5;
            const hand = a.hands[k];
            hand.visible = vis;
            if (vis) {
              hand.position.set(f.props[o], f.props[o + 1], f.props[o + 2]);
              hand.quaternion.set(f.props[o + 3], f.props[o + 4], f.props[o + 5], f.props[o + 6]);
            }
          }
        }
        const showH = f.assist > 0.02 && l !== 3;
        a.harness.visible = showH;
        if (showH) {
          const H = 4;
          a.harness.scale.set(1, H, 1);
          a.harness.position.set(f.tr[base], f.tr[base + 1] + H / 2, 0);
        }
      }
      this.harnessMat.opacity = 0.12 + 0.4 * f.assist;
      const fi = Math.max(0, Math.min(f.focus, Math.max(0, f.n - 1)));
      const o = fi * R * 7;
      const tx = f.tr[o], ty = f.tr[o + 1] * 0.8 + 0.2, tz = f.tr[o + 2] + f.lane[fi];
      const k = 1 - Math.exp(-dt * 4);
      this.target.x += (tx - this.target.x) * k;
      this.target.y += (ty - this.target.y) * k;
      this.target.z += (tz - this.target.z) * k;
    }
    const k2 = 1 - Math.exp(-dt * 6);
    let dyaw = this.goal.yaw - this.view.yaw;
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    this.view.yaw += dyaw * k2;
    this.view.pitch += (this.goal.pitch - this.view.pitch) * k2;
    this.view.dist += (this.goal.dist - this.view.dist) * k2;
    const { yaw, pitch, dist } = this.view;
    const cp = Math.cos(pitch);
    this.camera.position.set(
      this.target.x + dist * cp * Math.cos(yaw),
      this.target.y + dist * Math.sin(pitch) + 0.3,
      this.target.z + dist * cp * Math.sin(yaw),
    );
    if (this.shake > 0) {
      this.shake -= dt;
      const s = this.shake * 0.4;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
    }
    this.camera.lookAt(this.target);
    this.sun.position.set(this.target.x + 6, 14, this.target.z + 8);
    this.sun.target.position.copy(this.target);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.renderer.dispose();
  }
}
