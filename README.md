# JWYN service (Netlify Functions)

TypeScript port of the JWYN backend. Deploys to Netlify alongside the
storefront widget — one platform, one repo, one deploy.

## Endpoints
| Route | Purpose |
|---|---|
| `GET  /api/health` | healthcheck |
| `POST /api/reconcile` | full SKU reconciliation; also runs on a 6-hourly schedule. Manual calls need `X-JWYN-Run-Secret`. |
| `POST /api/webhooks/shopify` | HMAC-verified product / inventory / uninstall webhooks |
| `POST /api/cart/build` | live revalidation, then cart create |

## Commerce rules live in Postgres, not here
`commerce_state`, `build_cart_lines()` and `revalidate_session()` are database
objects so every code path inherits them. These functions call them and must
never re-implement them.

```
CARTABLE    = ACTIVE + Online Store published + inventory > 0
INCOMING    = ACTIVE + Online Store published + inventory = 0
UNAVAILABLE = DRAFT / ARCHIVED / unpublished
UNKNOWN     = incomplete or failed sync — never Confirmed, never Express Interest
```

## Cart-build order (do not reorder)
1. live re-fetch from Shopify for this session's SKUs
2. write the mirror
3. `revalidate_session()` — demotes only changed lines
4. any change -> 409 with those lines; siblings stay confirmed
5. `build_cart_lines()` — gate blocks
6. `cartCreate` -> checkoutUrl

If the Shopify fetch fails, the endpoint returns **503 and no cart**. Falling
back to the mirror is exactly the staleness this step exists to prevent.

## Serverless notes
- `reconcile` is cursor-paged with a 7s budget inside the 10s function limit.
  An unfinished run returns `next_cursor`; call again with `?cursor=`.
- Only a **complete** sweep may flag a SKU as missing from Shopify. A partial
  run has not seen the whole catalogue, and flagging absence from partial
  evidence would wrongly push live products to `unknown`.
- Webhook handlers stay cheap and always return 200; the scheduled reconcile
  is the safety net.

## Setup
1. `npm install`
2. Set the variables from `.env.example` in Netlify -> Site configuration ->
   Environment variables.
3. Register Shopify webhooks to `https://<site>/api/webhooks/shopify` for
   `products/create`, `products/update`, `products/delete`,
   `inventory_levels/update`, `app/uninstalled`.
4. First live test: `POST /api/reconcile` with the run secret. Expect
   7 cartable / 14 incoming / 8 unavailable.

## Not yet implemented
- Storefront snippet / widget
- Multi-tenant credential storage (single tenant via env for now)
- `inventory_levels/update` carries an inventory_item_id, not a SKU; currently
  logged and picked up by the next reconcile
