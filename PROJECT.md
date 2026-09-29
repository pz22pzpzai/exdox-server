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

For multi-stop Android claims, `/mileage/route` also accepts optional `stops: string[]` in journey order. All postcodes are exact-match geocoded. Directions calls contain up to 25 ordered coordinates; longer journeys are split into overlapping sections and their driving distances, durations, roads, and map geometry are combined. Multi-stop requests return one route; the original two-postcode alternatives remain unchanged. Each extra distinct postcode uses another geocoding request, and a route above 25 coordinates uses more than one Directions request, so Mapbox usage rises with stops. This endpoint has a 20-second Lambda timeout and Mapbox/account limits still apply; manual miles remain available if calculation cannot finish.

The Android claim stores its full ordered postcode journey in the claim description. The synthetic mileage purchase row now prefers that description so reviewers see all stops in Purchases. Multi-stop API and purchase-row changes were pushed to `main` through commit `72ed1f4`; the owner checks the deployment workflow and live site.

## Caveats

- Two-factor login (2026-09-29): `/two-factor` GET/POST stores per-user email and authenticator settings in encrypted S3 objects under `security/two-factor/`; TOTP secrets are additionally encrypted with a key derived from `JWT_SECRET`. `/login` sends a six-digit email code through SES when email 2FA is enabled and withholds the session until an email, authenticator, or one-time recovery code is verified. Authenticator setup returns eight recovery codes once; only keyed hashes are stored. Email codes expire after 10 minutes, resends have a one-minute cooldown, and five failed attempts pause verification for 15 minutes. The new SAM route and SES permissions require server deployment before the website UI. Account deletion purges these objects. Do not rotate `JWT_SECRET` without a TOTP migration because existing authenticator secrets would become unreadable. The owner checks deployment and real SES delivery; never delete or move mobile signing keystores or signing details.

- The Android app is a separate project; this website routing work does not change its mileage form.
- Preserve unrelated working-tree changes. Do not commit build output or machine-specific files.
- Do not inspect the live site or deployment workflow after a push; the project owner checks them.
- Never delete or move a mobile app keystore or signing details. They belong to the separate app project.

## Country-aware workspaces (2026-09-29)

- Registration now stores GB, US, AU, CA, or one of 27 EUR-using countries and territories in `organisations.country`; existing rows default to GB. The API returns country in organisation settings and updates country, base currency, tax review default, and mileage rate. S3-backed organisations store the same fields.
- `src/aws/shared/workspaceCountry.ts` centralises country validation, currency, tax review defaults, and document locale. Non-UK OCR retains tax actually printed on the document without applying UK VAT foreign-tax handling. It does not determine tax due, recoverability, place of supply, or file returns. Existing historical records are not converted when an organisation changes its currency.
- Stripe subscription and trial prices remain GBP. The website shows approximate local currency references; Stripe and card issuers determine actual conversion and international card fees. No Stripe Tax or multi-currency price was added. The Android and iPhone app code was not changed.
