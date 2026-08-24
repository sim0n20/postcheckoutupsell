# Personalised Post Purchase — Shopify app

Production-oriented multi-store Shopify app for configurable post-purchase personalised product upsells.

## Included

- Shopify React Router embedded admin with OAuth/session storage.
- Multi-store PostgreSQL data model.
- Dashboard, offer list/editor, variant picker, multiple personalisation fields, production order queue, analytics, settings.
- Post-purchase `ShouldRender` and `Render` extension.
- Text, long-text, dropdown and checkbox personalisation schema.
- Server-side validation and signed `add_variant` + `set_metafield` changesets.
- Offer eligibility rules and priority.
- Acceptance idempotency and order-update reconciliation.
- App-uninstall and mandatory privacy webhook endpoints.
- Docker production build and local PostgreSQL Compose configuration.
- Core validation tests.

## Shopify platform requirement

Post-purchase extensions require Shopify approval for live production stores. Development stores can be used while building/testing. Availability is also subject to Shopify's post-purchase eligibility rules and supported payment methods. This code cannot bypass Shopify platform eligibility.

## Local setup

1. Install Node 22, Docker, Shopify CLI and create a Shopify Partner/dev app.
2. `cp .env.example .env` and set API key/secret.
3. `docker compose up -d db`
4. `npm install`
5. `npx prisma migrate dev --name init`
6. `shopify app dev`
7. Replace `__SHOPIFY_APP_URL__` in the post-purchase extension during deployment with the app's public HTTPS origin if your build pipeline does not inject it.

## Production setup

1. Provision PostgreSQL with backups and TLS.
2. Set `DATABASE_URL`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, and `SCOPES` in the hosting environment.
3. Replace `YOUR_APP_DOMAIN` in `shopify.app.toml` and run `shopify app config link` / `shopify app deploy`.
4. Deploy the Docker image to a Node-compatible HTTPS host.
5. Run `prisma migrate deploy` before app traffic (the Docker command does this automatically).
6. In Shopify Partner Dashboard, request/obtain post-purchase extension access before enabling on live stores.
7. Complete App Store listing, privacy policy, support contact, billing (if charging merchants), and Shopify app review.

## Merchant workflow

Open app → **Offers** → **Create offer** → choose a Shopify variant → configure discount/copy → add personalisation fields → activate. Accepted personalisations appear under **Personalised orders** and can move through Approved → In production → Completed.

## Production notes

- `orders/updated` reconciliation is intentionally defensive because post-purchase updates can be represented differently across order payload/version changes. For high-volume production, add a dedicated reconciliation job that queries the Admin GraphQL API using the order ID and app-owned metafield definition.
- Use an observability provider (Sentry, Datadog, etc.) and managed job queue before high-volume launch.
- Add merchant billing only if your commercial model requires it; it is not required for app functionality.
- The extension stores each accepted offer in a unique order metafield key derived from the offer ID to prevent one offer overwriting another.

## Tests

`npm test`

The source package is designed to be installed by multiple eligible Shopify stores under one public app registration; no per-store code fork is required.
