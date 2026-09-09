# JWYN service

Flask service for JWYN (Just What You Need). Deploys to Railway as its own
service, separate from `reveco-service`.

## Why a separate service
- Different database (`jwyn-core`, not `reveco`)
- Different lifecycle — ReVeCo is paused, JWYN is active
- A Shopify Admin token should not share a process with Razorpay keys
- Multi-tenant by design

## Endpoints
| Route | Purpose |
|---|---|
| `GET  /health` | healthcheck |
| `POST /admin/reconcile` | full SKU reconciliation; recovery for missed webhooks (requires `X-JWYN-Run-Secret`) |
| `POST /webhooks/shopify` | HMAC-verified product/inventory/uninstall webhooks |
| `POST /api/cart/build` | live revalidation, then cart create |

## Commerce rules live in Postgres, not here
`commerce_state`, `build_cart_lines()` and `revalidate_session()` are in the
database so every code path inherits them. This service calls them and must
never re-implement them.

CARTABLE = ACTIVE + published + inventory > 0
INCOMING = ACTIVE + published + inventory = 0
UNAVAILABLE = DRAFT / ARCHIVED / unpublished
UNKNOWN = incomplete or failed sync — never Confirmed, never Express Interest

## Cart-build order (do not reorder)
1. live re-fetch from Shopify for this session's SKUs
2. write the mirror
3. `revalidate_session()` — demotes only changed lines
4. any change -> 409 with those lines; siblings stay confirmed
5. `build_cart_lines()` — gate blocks
6. `cartCreate` -> checkoutUrl

Cart-time revalidation stays the final authority even once webhooks are live.

## Deploy
Railway service, root of this repo. `railway.json` sets the start command and
healthcheck. Set the variables in `.env.example` before first deploy.

## Not yet implemented
- Storefront snippet / widget
- Multi-tenant credential storage (single tenant via env for now)
- `inventory_levels/update` maps an inventory_item_id, not a SKU; currently
  logged and picked up by the next reconcile rather than resolved inline
