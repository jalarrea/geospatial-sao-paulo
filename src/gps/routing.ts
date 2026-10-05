// Geocoding (Nominatim) and driving directions (OSRM public demo server).
// Both are free, keyless OpenStreetMap services meant for light, demo usage.

export interface LonLat {
  lon: number;
  lat: number;
}

export interface Place extends LonLat {
  label: string;
}

export interface RouteStep {
  type: string;
  modifier?: string;
  name: string;
  distance: number; // meters
  duration: number; // seconds
  startDistance: number; // meters from route start
}

export interface Route {
  coordinates: LonLat[];
  // Per-segment annotations (coordinates.length - 1 entries).
  segmentDistance: number[];
  segmentDuration: number[];
  segmentSpeed: number[]; // m/s
  distance: number;
  duration: number;
  steps: RouteStep[];
}

export const PRESETS: Place[] = [
  { label: "MASP (Av. Paulista)", lat: -23.5614, lon: -46.6559 },
  { label: "Parque Ibirapuera", lat: -23.5874, lon: -46.6576 },
  { label: "Edifício Copan", lat: -23.5465, lon: -46.6443 },
  { label: "Ponte Estaiada", lat: -23.6107, lon: -46.6981 },
  { label: "Estação da Luz", lat: -23.5346, lon: -46.6353 },
  { label: "Mercado Municipal", lat: -23.5417, lon: -46.6297 },
  { label: "Allianz Parque", lat: -23.5275, lon: -46.6785 },
  { label: "Praça da Sé", lat: -23.5503, lon: -46.6339 },
];

// lon_min, lat_max, lon_max, lat_min around the city of São Paulo.
const SAO_PAULO_VIEWBOX = "-46.83,-23.36,-46.36,-23.80";

export async function resolvePlace(input: string): Promise<Place> {
  const text = input.trim();
  if (!text) {
    throw new Error("Enter an origin and a destination");
  }

  const preset = PRESETS.find(
    (p) => p.label.toLowerCase() === text.toLowerCase()
  );
  if (preset) {
    return preset;
  }

  const coords = text.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (coords) {
    return { lat: Number(coords[1]), lon: Number(coords[2]), label: text };
  }

  const url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&bounded=1" +
    `&viewbox=${SAO_PAULO_VIEWBOX}&q=${encodeURIComponent(text)}`;
  const response = await fetch(url, {
    headers: { "Accept-Language": "pt-BR" },
  });
  if (!response.ok) {
    throw new Error(`Geocoding failed (${response.status})`);
  }
  const results = (await response.json()) as Array<{
    lat: string;
    lon: string;
    display_name: string;
  }>;
  if (results.length === 0) {
    throw new Error(`No place found for "${text}" in São Paulo`);
  }
  return {
    lat: Number(results[0].lat),
    lon: Number(results[0].lon),
    label: results[0].display_name,
  };
}

export async function fetchRoute(from: LonLat, to: LonLat): Promise<Route> {
  const url =
    "https://router.project-osrm.org/route/v1/driving/" +
    `${from.lon},${from.lat};${to.lon},${to.lat}` +
    "?overview=full&geometries=geojson&steps=true&annotations=distance,duration,speed";
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Routing failed (${response.status})`);
  }
  const data = await response.json();
  if (data.code !== "Ok" || !data.routes?.length) {
    throw new Error(`No route found (${data.code ?? "unknown error"})`);
  }

  const route = data.routes[0];
  const leg = route.legs[0];
  let startDistance = 0;
  const steps: RouteStep[] = leg.steps.map((step: any) => {
    const result: RouteStep = {
      type: step.maneuver.type,
      modifier: step.maneuver.modifier,
      name: step.name || step.ref || "",
      distance: step.distance,
      duration: step.duration,
      startDistance,
    };
    startDistance += step.distance;
    return result;
  });

  return {
    coordinates: route.geometry.coordinates.map(([lon, lat]: number[]) => ({
      lon,
      lat,
    })),
    segmentDistance: leg.annotation.distance,
    segmentDuration: leg.annotation.duration,
    segmentSpeed: leg.annotation.speed,
    distance: route.distance,
    duration: route.duration,
    steps,
  };
}

export function describeStep(step: RouteStep): string {
  const onto = step.name ? ` onto ${step.name}` : "";
  const on = step.name ? ` on ${step.name}` : "";
  const modifier = step.modifier ?? "";
  switch (step.type) {
    case "depart":
      return `Head out${on}`;
    case "arrive":
      return "Arrive at destination";
    case "roundabout":
    case "rotary":
    case "roundabout turn":
      return `Take the roundabout${onto}`;
    case "merge":
      return `Merge${onto}`;
    case "on ramp":
      return `Take the ramp${onto}`;
    case "off ramp":
      return `Take the exit${onto}`;
    case "fork":
      return `Keep ${modifier.includes("left") ? "left" : "right"}${onto}`;
    case "continue":
    case "new name":
      return `Continue${on}`;
    default:
      if (modifier === "straight") return `Continue${on}`;
      if (modifier === "uturn") return `Make a U-turn${onto}`;
      return `Turn ${modifier || "ahead"}${onto}`;
  }
}

// Arrow rotation in degrees (0 = straight ahead, positive = right).
export function maneuverAngle(step: RouteStep): number {
  if (step.type === "arrive") return 0;
  switch (step.modifier) {
    case "slight right":
      return 40;
    case "right":
      return 90;
    case "sharp right":
      return 135;
    case "uturn":
      return 180;
    case "slight left":
      return -40;
    case "left":
      return -90;
    case "sharp left":
      return -135;
    default:
      return 0;
  }
}
