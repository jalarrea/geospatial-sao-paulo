import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  GreaterDepth,
  Group,
  LessEqualDepth,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  Raycaster,
  RingGeometry,
  Shape,
  ShapeGeometry,
  ShaderMaterial,
  Vector3,
} from "three";
import type { TilesRenderer } from "3d-tiles-renderer";
import { Ellipsoid, Geodetic, radians } from "@takram/three-geospatial";
import type { Route } from "./routing";

const SAMPLE_SPACING = 8; // meters between route samples
const RIBBON_WIDTH = 11; // meters
const RIBBON_LIFT = 2; // meters above the sampled ground
const RAYS_PER_FRAME = 30;
const RAY_START_HEIGHT = 700; // meters above the ellipsoid guess

const ribbonVertexShader = /* glsl */ `
  attribute float aDistance;
  attribute float aSide;
  varying float vDistance;
  varying float vSide;
  void main() {
    vDistance = aDistance;
    vSide = aSide;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const ribbonFragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uProgress;
  uniform float uOpacity;
  varying float vDistance;
  varying float vSide;
  void main() {
    float side = abs(vSide);
    float edge = smoothstep(0.72, 0.95, side);
    // Chevrons pointing and scrolling toward the destination.
    float v = fract(vDistance / 16.0 + side * 0.3 - uTime * 1.2);
    float chevron = smoothstep(0.0, 0.05, v) * (1.0 - smoothstep(0.2, 0.28, v));
    vec3 yellow = vec3(1.0, 0.7, 0.04);
    vec3 color = yellow * (0.6 + 1.2 * chevron) + vec3(1.0, 0.9, 0.45) * edge * 1.8;
    float travelled = step(vDistance, uProgress);
    color = mix(color, vec3(0.05, 0.4, 0.55), travelled);
    gl_FragColor = vec4(color, uOpacity * mix(1.0, 0.45, travelled));
  }
`;

// Route ribbon, vehicle marker and endpoint beacons, built in a local
// east-north-up frame anchored at the route start for float precision.
// Ground heights come from raycasting the loaded tiles and keep refining as
// higher levels of detail stream in.
export class RouteLayer {
  readonly group = new Group();

  private readonly frame = new Matrix4();
  private readonly frameInverse = new Matrix4();
  private readonly raycaster = new Raycaster();
  private readonly uniforms = {
    uTime: { value: 0 },
    uProgress: { value: 0 },
  };

  private xs = new Float64Array(0);
  private ys = new Float64Array(0);
  private baseZ = new Float64Array(0); // ellipsoid-relative guess
  private rawZ = new Float64Array(0); // last raycast result (NaN = no hit)
  private groundZ = new Float64Array(0); // filtered
  private distances = new Float64Array(0);
  private sampleCursor = 0;
  private heightsDirty = false;
  private rebuildTimer = 0;

  private ribbon?: { geometry: BufferGeometry; meshes: Mesh[] };
  private readonly vehicle = this.createVehicle();
  private readonly startBeacon = this.createBeacon(new Color(0.1, 0.7, 1.0));
  private readonly endBeacon = this.createBeacon(new Color(2.0, 1.4, 0.1));

  constructor(private readonly tiles: TilesRenderer) {
    this.group.matrixAutoUpdate = false;
    this.group.visible = false;
    this.group.add(this.vehicle, this.startBeacon, this.endBeacon);
    // Honored by TilesRenderer's optimized raycast.
    (this.raycaster as Raycaster & { firstHitOnly: boolean }).firstHitOnly = true;
  }

  get length(): number {
    return this.distances.length > 0
      ? this.distances[this.distances.length - 1]
      : 0;
  }

  setRoute(route: Route, groundHeightGuess: number): void {
    this.disposeRibbon();

    const first = route.coordinates[0];
    const origin = new Geodetic(
      radians(first.lon),
      radians(first.lat),
      groundHeightGuess
    ).toECEF();
    Ellipsoid.WGS84.getEastNorthUpFrame(origin, this.frame);
    this.frameInverse.copy(this.frame).invert();
    this.group.matrix.copy(this.frame);
    this.group.matrixWorldNeedsUpdate = true;

    // Project the polyline into the local frame.
    const local = route.coordinates.map(({ lon, lat }) =>
      new Geodetic(radians(lon), radians(lat), groundHeightGuess)
        .toECEF()
        .applyMatrix4(this.frameInverse)
    );

    // Resample at a fixed spacing so the ribbon and heights are uniform.
    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    const ds: number[] = [];
    let travelled = 0;
    for (let i = 0; i < local.length - 1; i++) {
      const a = local[i];
      const b = local[i + 1];
      const segment = a.distanceTo(b);
      if (segment < 1e-3) continue;
      const count = Math.max(1, Math.ceil(segment / SAMPLE_SPACING));
      for (let k = 0; k < count; k++) {
        const t = k / count;
        xs.push(a.x + (b.x - a.x) * t);
        ys.push(a.y + (b.y - a.y) * t);
        zs.push(a.z + (b.z - a.z) * t);
        ds.push(travelled + segment * t);
      }
      travelled += segment;
    }
    const last = local[local.length - 1];
    xs.push(last.x);
    ys.push(last.y);
    zs.push(last.z);
    ds.push(travelled);

    this.xs = Float64Array.from(xs);
    this.ys = Float64Array.from(ys);
    this.baseZ = Float64Array.from(zs);
    this.rawZ = new Float64Array(zs.length).fill(NaN);
    this.groundZ = Float64Array.from(zs);
    this.distances = Float64Array.from(ds);
    this.sampleCursor = 0;

    this.buildRibbon();
    this.placeBeacon(this.startBeacon, 0);
    this.placeBeacon(this.endBeacon, xs.length - 1);
    this.group.visible = true;
  }

  clear(): void {
    this.disposeRibbon();
    this.group.visible = false;
    this.distances = new Float64Array(0);
  }

  // Position (world/ECEF) and heading (radians, counterclockwise from east)
  // at a distance along the route.
  sample(distance: number, position: Vector3): number {
    const n = this.distances.length;
    if (n === 0) return 0;
    const d = Math.min(Math.max(distance, 0), this.length);
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.distances[mid] <= d) lo = mid;
      else hi = mid;
    }
    const span = this.distances[hi] - this.distances[lo];
    const t = span > 0 ? (d - this.distances[lo]) / span : 0;
    position.set(
      this.xs[lo] + (this.xs[hi] - this.xs[lo]) * t,
      this.ys[lo] + (this.ys[hi] - this.ys[lo]) * t,
      this.groundZ[lo] + (this.groundZ[hi] - this.groundZ[lo]) * t
    );
    // Look a little ahead for a stable heading.
    const ahead = Math.min(hi + 3, n - 1);
    const behind = Math.max(ahead - 6, 0);
    const heading = Math.atan2(
      this.ys[ahead] - this.ys[behind],
      this.xs[ahead] - this.xs[behind]
    );
    position.applyMatrix4(this.frame);
    return heading;
  }

  // Center and radius (world/ECEF) of the route, for an overview camera.
  bounds(center: Vector3): number {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity,
      sumZ = 0;
    for (let i = 0; i < this.xs.length; i++) {
      minX = Math.min(minX, this.xs[i]);
      maxX = Math.max(maxX, this.xs[i]);
      minY = Math.min(minY, this.ys[i]);
      maxY = Math.max(maxY, this.ys[i]);
      sumZ += this.groundZ[i];
    }
    center
      .set((minX + maxX) / 2, (minY + maxY) / 2, sumZ / this.xs.length)
      .applyMatrix4(this.frame);
    return Math.hypot(maxX - minX, maxY - minY) / 2;
  }

  setVehicle(distance: number, time: number): void {
    if (this.distances.length === 0) return;
    const position = new Vector3();
    const heading = this.sample(distance, position);
    position.applyMatrix4(this.frameInverse);
    this.vehicle.position.set(position.x, position.y, position.z + RIBBON_LIFT + 1);
    this.vehicle.rotation.set(0, 0, heading);
    const ring = this.vehicle.children[1];
    const pulse = (time * 0.8) % 1;
    ring.scale.setScalar(1 + pulse * 2.5);
    ((ring as Mesh).material as MeshBasicMaterial).opacity = 0.8 * (1 - pulse);
    this.uniforms.uProgress.value = distance;
  }

  update(deltaTime: number, time: number): void {
    this.uniforms.uTime.value = time;
    if (this.distances.length === 0) return;

    this.sampleHeights();
    this.rebuildTimer -= deltaTime;
    if (this.heightsDirty && this.rebuildTimer <= 0) {
      this.rebuildTimer = 0.4;
      this.heightsDirty = false;
      this.filterHeights();
      this.updateRibbonPositions();
      this.placeBeacon(this.startBeacon, 0);
      this.placeBeacon(this.endBeacon, this.xs.length - 1);
    }
  }

  private sampleHeights(): void {
    const n = this.xs.length;
    const origin = new Vector3();
    const down = new Vector3(0, 0, -1).transformDirection(this.frame);
    const hits: Array<{ point: Vector3 }> = [];
    for (let k = 0; k < Math.min(RAYS_PER_FRAME, n); k++) {
      const i = this.sampleCursor;
      this.sampleCursor = (this.sampleCursor + 1) % n;
      origin
        .set(this.xs[i], this.ys[i], this.baseZ[i] + RAY_START_HEIGHT)
        .applyMatrix4(this.frame);
      this.raycaster.set(origin, down);
      this.raycaster.far = RAY_START_HEIGHT * 2;
      hits.length = 0;
      this.raycaster.intersectObject(this.tiles.group, true, hits as any);
      if (hits.length === 0) continue;
      const z = hits[0].point.applyMatrix4(this.frameInverse).z;
      if (Number.isNaN(this.rawZ[i]) || Math.abs(this.rawZ[i] - z) > 0.3) {
        this.rawZ[i] = z;
        this.heightsDirty = true;
      }
    }
  }

  // Rays also hit rooftops, trees and overpasses above the road, so take a
  // low percentile over ~130 m of route (the street is the lowest surface),
  // then smooth it.
  private filterHeights(): void {
    const n = this.rawZ.length;
    const low = new Float64Array(n);
    const window: number[] = [];
    let lastKnown = NaN;
    for (let i = 0; i < n; i++) {
      window.length = 0;
      for (let j = Math.max(0, i - 8); j <= Math.min(n - 1, i + 8); j++) {
        if (!Number.isNaN(this.rawZ[j])) window.push(this.rawZ[j]);
      }
      if (window.length > 0) {
        window.sort((a, b) => a - b);
        lastKnown = window[Math.floor(window.length * 0.2)];
      }
      low[i] = Number.isNaN(lastKnown) ? this.baseZ[i] : lastKnown;
    }
    // Backfill samples before the first hit.
    const firstHit = this.rawZ.findIndex((z) => !Number.isNaN(z));
    if (firstHit > 0) low.fill(low[firstHit], 0, firstHit);

    for (let i = 0; i < n; i++) {
      let sum = 0;
      let count = 0;
      for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) {
        sum += low[j];
        count++;
      }
      this.groundZ[i] = sum / count;
    }
  }

  private buildRibbon(): void {
    const n = this.xs.length;
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(n * 6), 3));
    const distance = new Float32Array(n * 2);
    const side = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      distance[i * 2] = distance[i * 2 + 1] = this.distances[i];
      side[i * 2] = -1;
      side[i * 2 + 1] = 1;
    }
    geometry.setAttribute("aDistance", new BufferAttribute(distance, 1));
    geometry.setAttribute("aSide", new BufferAttribute(side, 1));
    const index: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geometry.setIndex(index);

    // Visible part at full strength, the part hidden behind buildings faint.
    const meshes = [
      { depthFunc: GreaterDepth, opacity: 0.2, blending: AdditiveBlending, order: 1 },
      { depthFunc: LessEqualDepth, opacity: 1, blending: NormalBlending, order: 2 },
    ].map(({ depthFunc, opacity, blending, order }) => {
      const material = new ShaderMaterial({
        vertexShader: ribbonVertexShader,
        fragmentShader: ribbonFragmentShader,
        uniforms: { ...this.uniforms, uOpacity: { value: opacity } },
        transparent: true,
        depthWrite: false,
        depthFunc,
        blending,
        side: DoubleSide,
      });
      const mesh = new Mesh(geometry, material);
      mesh.renderOrder = order;
      mesh.frustumCulled = false;
      return mesh;
    });
    this.group.add(...meshes);
    this.ribbon = { geometry, meshes };
    this.updateRibbonPositions();
  }

  private updateRibbonPositions(): void {
    if (!this.ribbon) return;
    const n = this.xs.length;
    const positions = this.ribbon.geometry.getAttribute("position") as BufferAttribute;
    const half = RIBBON_WIDTH / 2;
    for (let i = 0; i < n; i++) {
      const a = Math.max(i - 1, 0);
      const b = Math.min(i + 1, n - 1);
      let tx = this.xs[b] - this.xs[a];
      let ty = this.ys[b] - this.ys[a];
      const length = Math.hypot(tx, ty) || 1;
      tx /= length;
      ty /= length;
      const z = this.groundZ[i] + RIBBON_LIFT;
      positions.setXYZ(i * 2, this.xs[i] + ty * half, this.ys[i] - tx * half, z);
      positions.setXYZ(i * 2 + 1, this.xs[i] - ty * half, this.ys[i] + tx * half, z);
    }
    positions.needsUpdate = true;
    this.ribbon.geometry.computeBoundingSphere();
  }

  private disposeRibbon(): void {
    if (!this.ribbon) return;
    for (const mesh of this.ribbon.meshes) {
      this.group.remove(mesh);
      (mesh.material as ShaderMaterial).dispose();
    }
    this.ribbon.geometry.dispose();
    this.ribbon = undefined;
  }

  private placeBeacon(beacon: Mesh, index: number): void {
    beacon.position.set(this.xs[index], this.ys[index], this.groundZ[index] + 150);
  }

  private createVehicle(): Group {
    const shape = new Shape();
    shape.moveTo(14, 0);
    shape.lineTo(-8, 8);
    shape.lineTo(-3, 0);
    shape.lineTo(-8, -8);
    shape.closePath();
    const arrow = new Mesh(
      new ShapeGeometry(shape),
      new MeshBasicMaterial({
        color: new Color(1.6, 2.4, 2.8),
        depthTest: false,
        side: DoubleSide,
      })
    );
    const ring = new Mesh(
      new RingGeometry(9, 11, 48),
      new MeshBasicMaterial({
        color: new Color(0.3, 1.5, 2.0),
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: AdditiveBlending,
        side: DoubleSide,
      })
    );
    const vehicle = new Group();
    vehicle.add(arrow, ring);
    vehicle.traverse((object) => {
      object.renderOrder = 10;
      object.frustumCulled = false;
    });
    return vehicle;
  }

  private createBeacon(color: Color): Mesh {
    const beacon = new Mesh(
      new CylinderGeometry(1.2, 2.5, 300, 16, 1, true),
      new MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
        blending: AdditiveBlending,
        side: DoubleSide,
      })
    );
    beacon.rotation.x = Math.PI / 2; // cylinder axis along local up (z)
    beacon.renderOrder = 3;
    return beacon;
  }
}
