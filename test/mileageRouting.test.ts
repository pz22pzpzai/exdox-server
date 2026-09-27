import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateMileageRoutes, MileageRoutingError } from '../src/aws/shared/mileageRouting.js';

test('calculates driving miles and alternatives from exact UK postcodes', async () => {
  const urls: URL[] = [];
  const fetcher = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    if (url.pathname.includes('/geocode/')) {
      const postcode = url.searchParams.get('q');
      return Response.json({ features: [{ properties: { feature_type: 'postcode', name: postcode }, geometry: { coordinates: postcode === 'SW1A 1AA' ? [-0.141, 51.501] : [-0.128, 51.507] } }] });
    }
    return Response.json({ code: 'Ok', routes: [
      { distance: 3218.688, duration: 360, legs: [{ steps: [{ name: 'A3212', distance: 2200 }] }] },
      { distance: 4828.032, duration: 480, legs: [{ steps: [{ name: 'A4', distance: 3000 }] }] },
    ] });
  };
  const result = await calculateMileageRoutes('sw1a1aa', 'wc2n 5du', 'public-token', fetcher as typeof fetch);
  assert.deepEqual(result, {
    startPostcode: 'SW1A 1AA', endPostcode: 'WC2N 5DU',
    routes: [
      { miles: 2, durationMinutes: 6, via: ['A3212'] },
      { miles: 3, durationMinutes: 8, via: ['A4'] },
    ],
  });
  assert.equal(urls.length, 3);
  assert.equal(urls[0].searchParams.get('types'), 'postcode');
  assert.equal(urls[2].searchParams.get('alternatives'), 'true');
});

test('rejects a postcode that Mapbox did not match exactly', async () => {
  const fetcher = async () => Response.json({ features: [{ properties: { feature_type: 'postcode', name: 'SW1A 2AA' }, geometry: { coordinates: [-0.141, 51.501] } }] });
  await assert.rejects(
    calculateMileageRoutes('SW1A 1AA', 'WC2N 5DU', 'public-token', fetcher as typeof fetch),
    (error: unknown) => error instanceof MileageRoutingError && error.code === 'postcode_not_found',
  );
});

test('rejects invalid or identical postcodes before contacting Mapbox', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; return Response.json({}); };
  await assert.rejects(calculateMileageRoutes('invalid', 'WC2N 5DU', 'public-token', fetcher as typeof fetch));
  await assert.rejects(calculateMileageRoutes('SW1A 1AA', 'sw1a1aa', 'public-token', fetcher as typeof fetch));
  assert.equal(calls, 0);
});

test('adds a Mapbox route preview without exposing the token in the result', async () => {
  const urls: URL[] = [];
  const fetcher = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    if (url.pathname.includes('/geocode/')) {
      const postcode = url.searchParams.get('q');
      return Response.json({ features: [{ properties: { feature_type: 'postcode', name: postcode }, geometry: { coordinates: postcode === 'SW1A 1AA' ? [-0.141, 51.501] : [-0.128, 51.507] } }] });
    }
    if (url.pathname.includes('/directions/')) {
      return Response.json({ code: 'Ok', routes: [{
        distance: 3218.688, duration: 360,
        geometry: { type: 'LineString', coordinates: [[-0.141, 51.501], [-0.135, 51.504], [-0.128, 51.507]] },
        legs: [{ steps: [] }],
      }] });
    }
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
  };
  const result = await calculateMileageRoutes('SW1A 1AA', 'WC2N 5DU', 'public-token', fetcher as typeof fetch, true);
  assert.equal(urls.length, 4);
  assert.equal(urls[2].searchParams.get('overview'), 'simplified');
  assert.equal(urls[2].searchParams.get('geometries'), 'geojson');
  assert.match(urls[3].pathname, /\/static\/path-5\+/);
  assert.equal(result.routes[0].mapImage, 'data:image/png;base64,iVBORw==');
  assert.doesNotMatch(JSON.stringify(result), /public-token/);
});
