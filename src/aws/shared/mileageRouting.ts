const METRES_PER_MILE = 1609.344;
const MAPBOX_TIMEOUT_MS = 8000;

type Coordinate = [number, number];

export type MileageRoute = {
  miles: number;
  durationMinutes: number;
  via: string[];
};

export type MileageRouteResult = {
  startPostcode: string;
  endPostcode: string;
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

export async function calculateMileageRoutes(
  startInput: unknown,
  endInput: unknown,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<MileageRouteResult> {
  const startPostcode = normalizeUkPostcode(startInput);
  const endPostcode = normalizeUkPostcode(endInput);
  if (startPostcode === endPostcode) {
    throw new MileageRoutingError('Enter different start and end postcodes.', 400, 'same_postcode');
  }
  if (!token.trim()) {
    throw new MileageRoutingError('Automatic mileage is not configured yet. Enter the mileage manually.', 503, 'routing_not_configured');
  }
  const [start, end] = await Promise.all([
    geocodePostcode(startPostcode, token, fetcher),
    geocodePostcode(endPostcode, token, fetcher),
  ]);
  const url = new URL(`https://api.mapbox.com/directions/v5/mapbox/driving/${start.join(',')};${end.join(',')}`);
  url.searchParams.set('alternatives', 'true');
  url.searchParams.set('steps', 'true');
  url.searchParams.set('overview', 'false');
  url.searchParams.set('access_token', token);
  const payload = await mapboxJson<{
    code?: string;
    routes?: Array<{ distance?: number; duration?: number; legs?: Array<{ steps?: Array<{ name?: string; distance?: number }> }> }>;
  }>(url, fetcher);
  if (payload.code !== 'Ok' || !payload.routes?.length) {
    throw new MileageRoutingError('No driving route was found between these postcodes. Enter the mileage manually.', 422, 'route_not_found');
  }
  const routes = payload.routes
    .filter((route) => Number.isFinite(route.distance) && Number(route.distance) > 0)
    .slice(0, 3)
    .map((route) => {
      const namedSteps = (route.legs ?? []).flatMap((leg) => leg.steps ?? [])
        .filter((step) => step.name?.trim() && Number(step.distance) >= 500)
        .sort((a, b) => Number(b.distance) - Number(a.distance));
      const via = [...new Set(namedSteps.map((step) => step.name!.trim()))].slice(0, 3);
      return {
        miles: Number((Number(route.distance) / METRES_PER_MILE).toFixed(1)),
        durationMinutes: Math.max(1, Math.round(Number(route.duration ?? 0) / 60)),
        via,
      };
    });
  if (!routes.length) {
    throw new MileageRoutingError('No driving route was found between these postcodes. Enter the mileage manually.', 422, 'route_not_found');
  }
  return { startPostcode, endPostcode, routes };
}
