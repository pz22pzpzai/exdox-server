const METRES_PER_MILE = 1609.344;
const MAPBOX_TIMEOUT_MS = 8000;

type Coordinate = [number, number];

export type MileageRoute = {
  miles: number;
  durationMinutes: number;
  via: string[];
  mapImage?: string;
};

export type MileageRouteResult = {
  startPostcode: string;
  endPostcode: string;
  stops?: string[];
  routes: MileageRoute[];
};

export class MileageRoutingError extends Error {
  constructor(message: string, readonly statusCode: number, readonly code: string) {
    super(message);
  }
}

export function normalizeUkPostcode(value: unknown): string {
  const compact = String(value ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!/^(GIR0AA|[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2})$/.test(compact)) {
    throw new MileageRoutingError('Enter a valid UK postcode.', 400, 'invalid_postcode');
  }
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

async function mapboxJson<T>(url: URL, fetcher: typeof fetch): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(url, { signal: AbortSignal.timeout(MAPBOX_TIMEOUT_MS) });
  } catch {
    throw new MileageRoutingError('The route service could not be reached. Enter the mileage manually or try again.', 502, 'routing_unavailable');
  }
  if (response.status === 429) {
    throw new MileageRoutingError('The route service is temporarily busy. Enter the mileage manually or try again.', 503, 'routing_rate_limited');
  }
  if (!response.ok) {
    throw new MileageRoutingError('The route service could not calculate this journey. Enter the mileage manually or try again.', 502, 'routing_unavailable');
  }
  return response.json() as Promise<T>;
}

async function geocodePostcode(postcode: string, token: string, fetcher: typeof fetch): Promise<Coordinate> {
  const url = new URL('https://api.mapbox.com/search/geocode/v6/forward');
  url.searchParams.set('q', postcode);
  url.searchParams.set('country', 'gb');
  url.searchParams.set('types', 'postcode');
  url.searchParams.set('limit', '1');
  url.searchParams.set('access_token', token);
  const payload = await mapboxJson<{
    features?: Array<{ properties?: { feature_type?: string; name?: string }; geometry?: { coordinates?: number[] } }>;
  }>(url, fetcher);
  const feature = payload.features?.[0];
  const matchedPostcode = String(feature?.properties?.name ?? '').toUpperCase().replace(/\s+/g, '');
  const coordinates = feature?.geometry?.coordinates;
  if (feature?.properties?.feature_type !== 'postcode' || matchedPostcode !== postcode.replace(/\s/g, '') ||
    !Array.isArray(coordinates) || coordinates.length < 2 ||
    !coordinates.slice(0, 2).every((coordinate) => Number.isFinite(coordinate))) {
    throw new MileageRoutingError(`Mapbox could not find ${postcode}. Check the postcode and try again.`, 400, 'postcode_not_found');
  }
  return [coordinates[0], coordinates[1]];
}

function encodePolyline(coordinates: number[][]): string {
  let previousLatitude = 0;
  let previousLongitude = 0;
  let result = '';
  const encodeValue = (value: number) => {
    let shifted = value < 0 ? ~(value << 1) : value << 1;
    while (shifted >= 0x20) {
      result += String.fromCharCode((0x20 | (shifted & 0x1f)) + 63);
      shifted >>>= 5;
    }
    result += String.fromCharCode(shifted + 63);
  };
  for (const [longitude, latitude] of coordinates) {
    const nextLatitude = Math.round(latitude * 1e5);
    const nextLongitude = Math.round(longitude * 1e5);
    encodeValue(nextLatitude - previousLatitude);
    encodeValue(nextLongitude - previousLongitude);
    previousLatitude = nextLatitude;
    previousLongitude = nextLongitude;
  }
  return result;
}

async function routeMapImage(
  coordinates: number[][],
  start: Coordinate,
  end: Coordinate,
  token: string,
  fetcher: typeof fetch,
): Promise<string | undefined> {
  if (coordinates.length < 2 || coordinates.some((point) => point.length < 2 ||
    !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) return undefined;
  // Static Images URLs have a length limit. Keep enough points for a clear phone-sized route preview.
  const stride = Math.max(1, Math.ceil((coordinates.length - 2) / 140));
  const sampled = coordinates.filter((_, index) => index === 0 || index === coordinates.length - 1 || index % stride === 0);
  const line = encodeURIComponent(encodePolyline(sampled));
  const point = ([longitude, latitude]: Coordinate) => `${longitude.toFixed(6)},${latitude.toFixed(6)}`;
  const overlays = `path-5+2563eb-0.95(${line}),pin-s-a+0c716a(${point(start)}),pin-s-b+0c716a(${point(end)})`;
  const url = new URL(`https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${overlays}/auto/600x360`);
  url.searchParams.set('padding', '36');
  url.searchParams.set('access_token', token);
  if (url.toString().length > 8000) return undefined;
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(MAPBOX_TIMEOUT_MS) });
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) return undefined;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 1_500_000) return undefined;
    return `data:${response.headers.get('content-type')};base64,${bytes.toString('base64')}`;
  } catch {
    return undefined;
  }
}

export async function calculateMileageRoutes(
  startInput: unknown,
  endInput: unknown,
  token: string,
  fetcher: typeof fetch = fetch,
  includeMap = false,
  stopsInput: unknown = [],
): Promise<MileageRouteResult> {
  const startPostcode = normalizeUkPostcode(startInput);
  const endPostcode = normalizeUkPostcode(endInput);
  if (!Array.isArray(stopsInput)) {
    throw new MileageRoutingError('Provide stops as a list of UK postcodes.', 400, 'invalid_stops');
  }
  const stops = stopsInput.map(normalizeUkPostcode);
  const postcodes = [startPostcode, ...stops, endPostcode];
  if (postcodes.some((postcode, index) => index > 0 && postcode === postcodes[index - 1])) {
    throw new MileageRoutingError('Enter different start and end postcodes.', 400, 'same_postcode');
  }
  if (!token.trim()) {
    throw new MileageRoutingError('Automatic mileage is not configured yet. Enter the mileage manually.', 503, 'routing_not_configured');
  }
  const geocoded = new Map<string, Coordinate>();
  await Promise.all([...new Set(postcodes)].map(async (postcode) => {
    geocoded.set(postcode, await geocodePostcode(postcode, token, fetcher));
  }));
  const coordinates = postcodes.map((postcode) => geocoded.get(postcode)!);
  const start = coordinates[0];
  const end = coordinates[coordinates.length - 1];
  type DirectionsRoute = { distance?: number; duration?: number; geometry?: { coordinates?: number[][] }; legs?: Array<{ steps?: Array<{ name?: string; distance?: number }> }> };
  const sectionStarts = Array.from({ length: Math.ceil((coordinates.length - 1) / 24) }, (_, index) => index * 24);
  const sections = await Promise.all(sectionStarts.map(async (first): Promise<DirectionsRoute[]> => {
    const section = coordinates.slice(first, Math.min(first + 25, coordinates.length));
    const url = new URL(`https://api.mapbox.com/directions/v5/mapbox/driving/${section.map((point) => point.join(',')).join(';')}`);
    url.searchParams.set('alternatives', coordinates.length === 2 ? 'true' : 'false');
    url.searchParams.set('steps', 'true');
    url.searchParams.set('overview', includeMap ? 'simplified' : 'false');
    if (includeMap) url.searchParams.set('geometries', 'geojson');
    url.searchParams.set('access_token', token);
    const payload = await mapboxJson<{
      code?: string;
      routes?: DirectionsRoute[];
    }>(url, fetcher);
    if (payload.code !== 'Ok' || !payload.routes?.length) {
      throw new MileageRoutingError('No driving route was found between these postcodes. Enter the mileage manually.', 422, 'route_not_found');
    }
    return payload.routes;
  }));
  const selectedRoutes = (sections.length === 1 ? sections[0] : [{
    distance: sections.reduce((sum, section) => sum + Number(section[0].distance ?? 0), 0),
    duration: sections.reduce((sum, section) => sum + Number(section[0].duration ?? 0), 0),
    legs: sections.flatMap((section) => section[0].legs ?? []),
    geometry: includeMap ? { coordinates: sections.flatMap((section, index) => (section[0].geometry?.coordinates ?? []).slice(index ? 1 : 0)) } : undefined,
  }])
    .filter((route) => Number.isFinite(route.distance) && Number(route.distance) > 0)
    .slice(0, 3);
  const routes = await Promise.all(selectedRoutes.map(async (route) => {
      const namedSteps = (route.legs ?? []).flatMap((leg) => leg.steps ?? [])
        .filter((step) => step.name?.trim() && Number(step.distance) >= 500)
        .sort((a, b) => Number(b.distance) - Number(a.distance));
      const via = [...new Set(namedSteps.map((step) => step.name!.trim()))].slice(0, 3);
      const mapImage = includeMap && route.geometry?.coordinates
        ? await routeMapImage(route.geometry.coordinates, start, end, token, fetcher)
        : undefined;
      return {
        miles: Number((Number(route.distance) / METRES_PER_MILE).toFixed(1)),
        durationMinutes: Math.max(1, Math.round(Number(route.duration ?? 0) / 60)),
        via,
        ...(mapImage ? { mapImage } : {}),
      };
    }));
  if (!routes.length) {
    throw new MileageRoutingError('No driving route was found between these postcodes. Enter the mileage manually.', 422, 'route_not_found');
  }
  return { startPostcode, endPostcode, ...(stops.length ? { stops } : {}), routes };
}
