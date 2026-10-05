import "./styles.css";

import {
  BloomEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
  VignetteEffect,
} from "postprocessing";
import {
  Clock,
  Color,
  HalfFloatType,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GlobeControls, TilesRenderer } from "3d-tiles-renderer";
import {
  GLTFExtensionsPlugin,
  GoogleCloudAuthPlugin,
  UnloadTilesPlugin,
  UpdateOnChangePlugin,
} from "3d-tiles-renderer/plugins";
import {
  Ellipsoid,
  Geodetic,
  PointOfView,
  degrees,
  radians,
} from "@takram/three-geospatial";
import { HoloMaterials } from "./holoMaterial";
import { RouteLayer } from "./routeLayer";
import {
  PRESETS,
  type Route,
  describeStep,
  fetchRoute,
  maneuverAngle,
  resolvePlace,
} from "./routing";

// Ground height of central São Paulo above the ellipsoid, used as the
// starting guess before tile raycasts refine it.
const GROUND_HEIGHT = 800;
const CITY_CENTER = { lon: -46.652, lat: -23.5635 };

type CameraMode = "free" | "follow" | "fly";

// --- DOM -------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const ui = {
  from: $<HTMLInputElement>("from"),
  to: $<HTMLInputElement>("to"),
  places: $<HTMLDataListElement>("places"),
  routeButton: $<HTMLButtonElement>("route-button"),
  playButton: $<HTMLButtonElement>("play-button"),
  speedSelect: $<HTMLSelectElement>("speed-select"),
  followButton: $<HTMLButtonElement>("follow-button"),
  overviewButton: $<HTMLButtonElement>("overview-button"),
  freeButton: $<HTMLButtonElement>("free-button"),
  status: $("status"),
  maneuver: $("maneuver"),
  maneuverArrow: $("maneuver-arrow"),
  maneuverDistance: $("maneuver-distance"),
  maneuverText: $("maneuver-text"),
  clock: $("clock"),
  speed: $("speed"),
  remaining: $("remaining"),
  elapsed: $("elapsed"),
  eta: $("eta"),
  progressBar: $("progress-bar"),
  street: $("street"),
  coords: $("coords"),
  credits: $("credits"),
};

// --- Scene -----------------------------------------------------------------

const renderer = new WebGLRenderer({
  powerPreference: "high-performance",
  antialias: false,
  stencil: false,
  depth: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
$("container").appendChild(renderer.domElement);

const scene = new Scene();
scene.background = new Color(0x00060c);

const camera = new PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  1,
  1e7
);

const centerECEF = new Geodetic(
  radians(CITY_CENTER.lon),
  radians(CITY_CENTER.lat),
  GROUND_HEIGHT
).toECEF();
const east = new Vector3();
const north = new Vector3();
const up = new Vector3();
Ellipsoid.WGS84.getEastNorthUpVectors(centerECEF, east, north, up);
const holo = new HoloMaterials(centerECEF, east, north, up);

const tiles = new TilesRenderer();
tiles.registerPlugin(
  new GoogleCloudAuthPlugin({
    apiToken: import.meta.env.VITE_GOOGLE_MAPS_JS_API_KEY,
    autoRefreshToken: true,
  })
);
tiles.registerPlugin(
  new GLTFExtensionsPlugin({
    dracoLoader: new DRACOLoader().setDecoderPath(
      "https://www.gstatic.com/draco/v1/decoders/"
    ),
  })
);
tiles.registerPlugin(new UpdateOnChangePlugin());
tiles.registerPlugin(new UnloadTilesPlugin());
tiles.addEventListener("load-model", (event: any) => holo.apply(event.scene));
tiles.setCamera(camera);
tiles.setResolutionFromRenderer(camera, renderer);
scene.add(tiles.group);

const controls = new GlobeControls(scene, camera, renderer.domElement, tiles);
controls.enableDamping = true;

const routeLayer = new RouteLayer(tiles);
scene.add(routeLayer.group);

const composer = new EffectComposer(renderer, {
  frameBufferType: HalfFloatType,
  multisampling: 4,
});
composer.addPass(new RenderPass(scene, camera));
composer.addPass(
  new EffectPass(
    camera,
    new BloomEffect({
      intensity: 1.6,
      luminanceThreshold: 0.3,
      luminanceSmoothing: 0.25,
      mipmapBlur: true,
      radius: 0.7,
    }),
    new VignetteEffect({ darkness: 0.55, offset: 0.3 })
  )
);

// --- Navigation state --------------------------------------------------------

let route: Route | undefined;
let cumulativeTime: number[] = [];
let cumulativeDistance: number[] = [];
let simTime = 0;
let playing = false;
let mode: CameraMode = "free";
let routeStartedAt = Date.now();

const flyTarget = { position: new Vector3(), quaternion: new Quaternion() };
let followHeading = 0;
let followHeadingReady = false;

const vehiclePosition = new Vector3();
const scratchPosition = new Vector3();
const scratchQuaternion = new Quaternion();
const geodetic = new Geodetic();

function setPose(
  target: Vector3,
  heading: number,
  pitch: number,
  distance: number,
  position: Vector3,
  quaternion: Quaternion
): void {
  new PointOfView(distance, heading, pitch).decompose(
    target,
    position,
    quaternion
  );
}

function setMode(next: CameraMode): void {
  mode = next;
  controls.enabled = next === "free";
  ui.followButton.classList.toggle("active", next === "follow");
  ui.freeButton.classList.toggle("active", next === "free");
}

function setStatus(message: string, isError = false): void {
  ui.status.textContent = message;
  ui.status.classList.toggle("error", isError);
}

function flyToOverview(): void {
  if (!route) return;
  const center = new Vector3();
  const radius = routeLayer.bounds(center);
  setPose(
    center,
    followHeadingReady ? followHeading : radians(90 - 305),
    radians(-50),
    Math.max(radius * 2.6, 900),
    flyTarget.position,
    flyTarget.quaternion
  );
  setMode("fly");
}

// Distance along the route (OSRM meters) at a simulated time.
function routeDistanceAt(time: number): { distance: number; segment: number } {
  let lo = 0;
  let hi = cumulativeTime.length - 1;
  if (time >= cumulativeTime[hi]) {
    return { distance: cumulativeDistance[hi], segment: hi - 1 };
  }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cumulativeTime[mid] <= time) lo = mid;
    else hi = mid;
  }
  const span = cumulativeTime[hi] - cumulativeTime[lo];
  const t = span > 0 ? (time - cumulativeTime[lo]) / span : 0;
  return {
    distance:
      cumulativeDistance[lo] +
      (cumulativeDistance[hi] - cumulativeDistance[lo]) * t,
    segment: lo,
  };
}

async function planRoute(): Promise<void> {
  ui.routeButton.disabled = true;
  setStatus("Resolving places…");
  try {
    const [from, to] = await Promise.all([
      resolvePlace(ui.from.value),
      resolvePlace(ui.to.value),
    ]);
    setStatus("Calculating route…");
    route = await fetchRoute(from, to);

    cumulativeTime = [0];
    cumulativeDistance = [0];
    route.segmentDuration.forEach((duration, i) => {
      cumulativeTime.push(cumulativeTime[i] + duration);
      cumulativeDistance.push(cumulativeDistance[i] + route!.segmentDistance[i]);
    });

    routeLayer.setRoute(route, GROUND_HEIGHT);
    simTime = 0;
    playing = false;
    followHeadingReady = false;
    routeStartedAt = Date.now();
    ui.playButton.disabled = false;
    ui.followButton.disabled = false;
    ui.overviewButton.disabled = false;
    ui.playButton.textContent = "▶ START";
    ui.maneuver.classList.remove("hidden");
    setStatus(
      `${(route.distance / 1000).toFixed(1)} km · ${Math.round(
        route.duration / 60
      )} min · ${route.steps.length} maneuvers`
    );
    flyToOverview();
  } catch (error) {
    setStatus((error as Error).message, true);
  } finally {
    ui.routeButton.disabled = false;
  }
}

// --- HUD ---------------------------------------------------------------------

const timeFormat = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  hour: "2-digit",
  minute: "2-digit",
});
const clockFormat = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function formatDistance(meters: number): string {
  return meters >= 1000
    ? `${(meters / 1000).toFixed(1)} km`
    : `${Math.max(0, Math.round(meters / 10) * 10)} m`;
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function updateHud(): void {
  ui.clock.textContent = clockFormat.format(new Date());
  ui.credits.textContent = tiles.getAttributions()[0]?.value ?? "";
  if (!route) return;

  const { distance, segment } = routeDistanceAt(simTime);
  const remaining = route.distance - distance;
  const moving = playing && remaining > 0;
  const speed = moving ? (route.segmentSpeed[segment] ?? 0) * 3.6 : 0;

  ui.speed.textContent = String(Math.round(speed)).padStart(3, "0");
  ui.remaining.textContent = (remaining / 1000).toFixed(1);
  ui.elapsed.textContent = formatDuration(simTime);
  ui.eta.textContent = timeFormat.format(
    new Date(routeStartedAt + route.duration * 1000)
  );
  ui.progressBar.style.width = `${(100 * distance) / route.distance}%`;

  let current = 0;
  while (
    current < route.steps.length - 1 &&
    route.steps[current + 1].startDistance <= distance
  ) {
    current++;
  }
  const next = route.steps[Math.min(current + 1, route.steps.length - 1)];
  const toNext =
    current + 1 < route.steps.length ? next.startDistance - distance : 0;
  ui.maneuverDistance.textContent =
    remaining <= 1 ? "ARRIVED" : formatDistance(toNext);
  ui.maneuverText.textContent = describeStep(next);
  ui.maneuverArrow.style.transform = `rotate(${maneuverAngle(next)}deg)`;
  ui.street.textContent = route.steps[current].name || "—";

  geodetic.setFromECEF(vehiclePosition);
  ui.coords.textContent = `${degrees(geodetic.latitude).toFixed(5)} / ${degrees(
    geodetic.longitude
  ).toFixed(5)}`;
}

// --- Loop --------------------------------------------------------------------

const clock = new Clock();
let elapsed = 0;
let hudTimer = 0;

function render(): void {
  const deltaTime = Math.min(clock.getDelta(), 0.1);
  elapsed += deltaTime;

  if (route) {
    if (playing) {
      simTime += deltaTime * Number(ui.speedSelect.value);
      if (simTime >= route.duration) {
        simTime = route.duration;
        playing = false;
        ui.playButton.textContent = "↺ RESTART";
        setStatus("Arrived at destination");
      }
    }
    // Map OSRM distance onto the resampled local polyline.
    const along =
      (routeDistanceAt(simTime).distance / route.distance) * routeLayer.length;
    routeLayer.setVehicle(along, elapsed);
    const heading = routeLayer.sample(along, vehiclePosition);

    if (!followHeadingReady) {
      followHeading = heading;
      followHeadingReady = true;
    }
    let delta = heading - followHeading;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    followHeading += delta * Math.min(1, deltaTime * 2.5);

    if (mode === "follow") {
      setPose(
        vehiclePosition,
        followHeading,
        radians(-28),
        260,
        scratchPosition,
        scratchQuaternion
      );
      const k = 1 - Math.exp(-deltaTime * 3);
      camera.position.lerp(scratchPosition, k);
      camera.quaternion.slerp(scratchQuaternion, k);
    }
  }

  if (mode === "fly") {
    const k = 1 - Math.exp(-deltaTime * 2.5);
    camera.position.lerp(flyTarget.position, k);
    camera.quaternion.slerp(flyTarget.quaternion, k);
    if (camera.position.distanceTo(flyTarget.position) < 2) {
      setMode("free");
    }
  }

  if (mode !== "free") {
    camera.near = 1;
    camera.far = 2e5;
    camera.updateProjectionMatrix();
  }
  controls.update();
  camera.updateMatrixWorld();

  tiles.setResolutionFromRenderer(camera, renderer);
  tiles.setCamera(camera);
  tiles.update();

  routeLayer.update(deltaTime, elapsed);
  holo.update(camera.matrixWorldInverse, elapsed);

  hudTimer -= deltaTime;
  if (hudTimer <= 0) {
    hudTimer = 0.1;
    updateHud();
  }

  composer.render(deltaTime);
}

// --- Wiring ------------------------------------------------------------------

for (const place of PRESETS) {
  const option = document.createElement("option");
  option.value = place.label;
  ui.places.appendChild(option);
}
ui.from.value = PRESETS[0].label;
ui.to.value = PRESETS[1].label;

ui.routeButton.addEventListener("click", planRoute);
for (const input of [ui.from, ui.to]) {
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") planRoute();
  });
}
ui.playButton.addEventListener("click", () => {
  if (!route) return;
  if (simTime >= route.duration) {
    simTime = 0;
    routeStartedAt = Date.now();
  }
  playing = !playing;
  ui.playButton.textContent = playing ? "❚❚ PAUSE" : "▶ RESUME";
  if (playing) {
    if (simTime === 0) routeStartedAt = Date.now();
    setMode("follow");
    setStatus("Navigating");
  }
});
ui.followButton.addEventListener("click", () => setMode("follow"));
ui.overviewButton.addEventListener("click", flyToOverview);
ui.freeButton.addEventListener("click", () => setMode("free"));

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// Start over Paulista, looking northwest along the avenue.
setPose(
  centerECEF,
  radians(90 - 305),
  radians(-35),
  2200,
  camera.position,
  camera.quaternion
);
setMode("free");
renderer.setAnimationLoop(render);
planRoute();
