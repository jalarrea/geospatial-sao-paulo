import {
  Color,
  Material,
  Matrix4,
  Mesh,
  Object3D,
  ShaderMaterial,
  Texture,
  Vector3,
} from "three";

// Stylized "holographic" material for the photorealistic tiles: dark
// geometry, glowing window grids on walls, a street grid on the ground and
// cyan rims. Heights and grid coordinates are computed in view space against
// a local origin so they keep full precision despite ECEF magnitudes.

const vertexShader = /* glsl */ `
  varying vec3 vViewPosition;
  #ifdef USE_HOLO_MAP
  varying vec2 vUv;
  #endif

  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewPosition = mvPosition.xyz;
    #ifdef USE_HOLO_MAP
    vUv = uv;
    #endif
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uViewOrigin;
  uniform vec3 uViewEast;
  uniform vec3 uViewNorth;
  uniform vec3 uViewUp;
  uniform vec3 uGlow;
  uniform vec3 uBase;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform float uTime;
  #ifdef USE_HOLO_MAP
  uniform sampler2D map;
  varying vec2 vUv;
  #endif
  varying vec3 vViewPosition;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float gridLine(vec2 coord) {
    vec2 g = abs(fract(coord - 0.5) - 0.5) / fwidth(coord);
    return 1.0 - min(min(g.x, g.y), 1.0);
  }

  void main() {
    vec3 normal = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
    vec3 viewDir = normalize(-vViewPosition);
    if (dot(normal, viewDir) < 0.0) normal = -normal;

    vec3 rel = vViewPosition - uViewOrigin;
    float height = dot(rel, uViewUp);
    float wall = 1.0 - smoothstep(0.35, 0.75, abs(dot(normal, uViewUp)));

    // Walls: a lattice of windows, a random subset lit.
    vec3 tangent = normalize(cross(uViewUp, normal) + 1e-5);
    vec2 cell = vec2(dot(rel, tangent) / 4.0, height / 3.4);
    vec2 cellId = floor(cell);
    vec2 f = fract(cell);
    float window = step(0.2, f.x) * step(f.x, 0.8) * step(0.3, f.y) * step(f.y, 0.75);
    float lit = step(0.5, hash(cellId)) * (0.6 + 0.8 * hash(cellId + 7.3));
    float floorLine = 1.0 - smoothstep(0.0, 0.08, abs(f.y - 0.05));
    vec3 wallColor = uBase + uGlow * (window * lit * 1.4 + floorLine * 0.12);

    // Ground and roofs: a faint street grid plus a scanning pulse.
    vec2 ground = vec2(dot(rel, uViewEast), dot(rel, uViewNorth));
    float grid = gridLine(ground / 60.0);
    float pulse = smoothstep(0.0, 1.0, 1.0 - abs(fract(length(ground) / 900.0 - uTime * 0.08) - 0.5) * 8.0);
    vec3 roofColor = uBase * 1.6 + uGlow * (grid * 0.35 + pulse * 0.08);

    #ifdef USE_HOLO_MAP
    float luma = dot(texture2D(map, vUv).rgb, vec3(0.299, 0.587, 0.114));
    roofColor += uGlow * luma * luma * 0.35;
    wallColor += uGlow * luma * 0.08;
    #endif

    float rim = pow(1.0 - abs(dot(normal, viewDir)), 4.0);
    vec3 color = mix(roofColor, wallColor, wall) + uGlow * rim * 0.5;

    float distance = length(vViewPosition);
    float fog = 1.0 - exp(-pow(distance * uFogDensity, 2.0));
    gl_FragColor = vec4(mix(color, uFogColor, fog), 1.0);
  }
`;

export class HoloMaterials {
  // Shared by every tile material so one update per frame reaches all.
  readonly uniforms = {
    uViewOrigin: { value: new Vector3() },
    uViewEast: { value: new Vector3() },
    uViewNorth: { value: new Vector3() },
    uViewUp: { value: new Vector3() },
    uGlow: { value: new Color(0.15, 0.85, 1.0) },
    uBase: { value: new Color(0.008, 0.02, 0.04) },
    uFogColor: { value: new Color(0.0, 0.012, 0.025) },
    uFogDensity: { value: 1 / 6000 },
    uTime: { value: 0 },
  };

  private readonly untextured = this.create();

  constructor(
    private readonly origin: Vector3,
    private readonly east: Vector3,
    private readonly north: Vector3,
    private readonly up: Vector3
  ) {}

  // Replaces the materials of a freshly loaded tile.
  apply(root: Object3D): void {
    root.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      const previous = mesh.material as Material & { map?: Texture | null };
      const map = previous.map ?? null;
      mesh.material = map ? this.create(map) : this.untextured;
      previous.dispose();
    });
  }

  update(viewMatrix: Matrix4, time: number): void {
    const u = this.uniforms;
    u.uViewOrigin.value.copy(this.origin).applyMatrix4(viewMatrix);
    u.uViewEast.value.copy(this.east).transformDirection(viewMatrix);
    u.uViewNorth.value.copy(this.north).transformDirection(viewMatrix);
    u.uViewUp.value.copy(this.up).transformDirection(viewMatrix);
    u.uTime.value = time;
  }

  private create(map?: Texture): ShaderMaterial {
    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: map ? { ...this.uniforms, map: { value: map } } : this.uniforms,
      defines: map ? { USE_HOLO_MAP: "" } : {},
    });
    if (map) {
      // Exposed as a property so TilesRenderer disposes it with the tile.
      (material as ShaderMaterial & { map: Texture }).map = map;
    }
    return material;
  }
}
