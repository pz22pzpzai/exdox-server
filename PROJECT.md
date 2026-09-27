# Exdox server

This repository contains the Exdox API and AWS SAM deployment. Source: `https://github.com/pz22pzpzai/exdox-server`. The production API is `https://hz2zkm6jkf.execute-api.eu-west-2.amazonaws.com/prod`; the website is `https://exdox.co.uk` and its separate source repository is `https://github.com/pz22pzpzai/exdox`.

## Main folders and commands

- `src/aws/handlers/`: individual API Lambda handlers.
- `src/aws/shared/`: authentication, data access, and shared services.
- `infra/template.yaml`: AWS SAM routes, parameters, and environment values.
- `.github/workflows/deploy.yml`: deployment on pushes to `main`, using protected GitHub `prod` environment secrets.
- `test/`: Node tests. Run `npm test` and `npm run build` before pushing.

## Mileage routing

`POST /mileage/route` requires an authenticated Exdox session and two UK postcodes. The handler uses Mapbox Temporary Geocoding v6 for exact postcode centres, then Directions driving routes and alternatives. It returns miles to one decimal place, travel time, and main road names. The website offers route selection but retains manual mileage adjustment because the actual journey may differ from the suggested route. The Mapbox access token is supplied only to the server through the `MAPBOX_ACCESS_TOKEN` protected `prod` GitHub environment secret and the SAM `MapboxAccessToken` parameter. Never commit or print the token. Mapbox usage is subject to account limits; no automatic paid upgrade is configured.

The protected `prod` environment secret was added on 2026-09-26. A subsequent push to `main` triggers deployment with this setting. The project owner checks the deployment workflow and live website.

The route API now accepts `includeMap: true` for the Android mileage sheet and website picker. It requests simplified Mapbox route geometry and renders each suggested/alternative route through the Static Images API; the response includes image data but never the access token. If image rendering fails, miles remain available for manual review. Both clients use the same route distances.

## Caveats

- The Android app is a separate project; this website routing work does not change its mileage form.
- Preserve unrelated working-tree changes. Do not commit build output or machine-specific files.
- Do not inspect the live site or deployment workflow after a push; the project owner checks them.
- Never delete or move a mobile app keystore or signing details. They belong to the separate app project.
