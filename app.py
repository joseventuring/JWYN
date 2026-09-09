"""JWYN service.

Responsibilities, in order of how much they matter:
  1. Never let a non-cartable line reach a Shopify cart.
  2. Keep the local Shopify mirror fresh (webhooks + periodic recovery).
  3. Build carts.

The commerce rules live in Postgres (generated columns, build_cart_lines,
revalidate_session) so every code path inherits them. This service must not
re-implement them — it calls them.
"""
import os, json, hmac, logging
from datetime import datetime, timezone
from flask import Flask, request, jsonify
from supabase import create_client
import shopify_client as shop

log = logging.getLogger("jwyn")
logging.basicConfig(level=logging.INFO)

app = Flask(__name__)
sb = create_client(os.environ["JWYN_SUPABASE_URL"],
                   os.environ["JWYN_SUPABASE_SERVICE_KEY"])

RUN_SECRET = os.environ.get("JWYN_RUN_SECRET", "")
TENANT_KEY = os.environ.get("JWYN_TENANT_KEY", "jinusgarage")

_tenant_cache = {}

def tenant_id():
    if TENANT_KEY not in _tenant_cache:
        r = sb.table("tenants").select("id").eq("tenant_key", TENANT_KEY).single().execute()
        _tenant_cache[TENANT_KEY] = r.data["id"]
    return _tenant_cache[TENANT_KEY]


# ===================================================================== sync
def _upsert_mirror(found, source, skus_expected=None):
    """Write the Shopify truth onto matching SKUs. Keyed strictly by SKU.

    A SKU we hold but Shopify did not return is marked with a sync error, so
    commerce_state falls to 'unknown' and it can never be confirmed. Silence
    is not evidence of availability.
    """
    tid, now = tenant_id(), datetime.now(timezone.utc).isoformat()
    matched, errored, logs = 0, 0, []

    for sku, v in found.items():
        res = sb.table("products").update({
            "shopify_product_gid":    v["shopify_product_gid"],
            "shopify_variant_gid":    v["shopify_variant_gid"],
            "shopify_status":         v["shopify_status"],
            "online_store_published": v["online_store_published"],
            "shopify_inventory_qty":  v["shopify_inventory_qty"],
            "shopify_synced_at":      now,
            "shopify_sync_error":     None,
            "sync_status":            "synced",
            "last_synced_at":         now,
        }).eq("tenant_id", tid).eq("sku", sku).execute()
        if res.data:
            matched += 1
            logs.append({"tenant_id": tid, "source": source, "sku": sku,
                         "outcome": "matched"})
        else:
            logs.append({"tenant_id": tid, "source": source, "sku": sku,
                         "outcome": "in_shopify_not_in_jwyn",
                         "detail": "SKU in Shopify, absent from catalogue"})

    if skus_expected:
        missing = [s for s in skus_expected if s not in found]
        for sku in missing:
            errored += 1
            sb.table("products").update({
                "shopify_sync_error": "not returned by Shopify in this run",
                "shopify_synced_at": now, "sync_status": "error",
            }).eq("tenant_id", tid).eq("sku", sku).execute()
            logs.append({"tenant_id": tid, "source": source, "sku": sku,
                         "outcome": "in_jwyn_not_in_shopify",
                         "detail": "SKU in catalogue, absent from Shopify"})

    if logs:
        sb.table("shopify_sync_log").insert(logs).execute()
    return matched, errored


@app.post("/admin/reconcile")
def reconcile():
    """Full catalogue reconciliation. Recovery for missed webhooks; run on a
    schedule as well as on demand. Webhooks are an optimisation, never the
    only path to correctness."""
    if not RUN_SECRET or request.headers.get("X-JWYN-Run-Secret") != RUN_SECRET:
        return jsonify(error="unauthorised"), 401
    tid = tenant_id()
    held = [r["sku"] for r in
            sb.table("products").select("sku").eq("tenant_id", tid).execute().data]
    found, dupes = shop.fetch_all_variants()
    matched, errored = _upsert_mirror(found, "reconcile", held)
    states = sb.table("products").select("commerce_state").eq("tenant_id", tid).execute().data
    counts = {}
    for r in states:
        counts[r["commerce_state"]] = counts.get(r["commerce_state"], 0) + 1
    return jsonify(shopify_variants=len(found), duplicate_skus=dupes,
                   matched=matched, sync_errors=errored, states=counts)


# ================================================================= webhooks
TOPICS = {"products/update", "products/create", "products/delete",
          "inventory_levels/update", "app/uninstalled"}

@app.post("/webhooks/shopify")
def webhook():
    raw = request.get_data()
    if not shop.verify_webhook(raw, request.headers.get("X-Shopify-Hmac-Sha256")):
        return jsonify(error="invalid hmac"), 401

    topic = request.headers.get("X-Shopify-Topic", "")
    payload = json.loads(raw or b"{}")

    # Acknowledge fast. Shopify retries on timeout, so the handler must be
    # cheap; anything slow belongs in the periodic reconcile.
    try:
        if topic in ("products/update", "products/create"):
            skus = [v.get("sku") for v in payload.get("variants", []) if v.get("sku")]
            if skus:
                _upsert_mirror(shop.fetch_variants_by_sku(skus), f"webhook:{topic}")
        elif topic == "products/delete":
            tid = datetime.now(timezone.utc).isoformat()
            sb.table("products").update({
                "shopify_sync_error": "product deleted in Shopify",
                "shopify_synced_at": tid, "sync_status": "error",
            }).eq("tenant_id", tenant_id()).eq(
                "shopify_product_gid",
                f"gid://shopify/Product/{payload.get('id')}").execute()
        elif topic == "inventory_levels/update":
            # Payload carries an inventory_item_id, not a SKU. Cheapest
            # correct move is a targeted refetch on the next reconcile tick.
            log.info("inventory webhook: item=%s available=%s",
                     payload.get("inventory_item_id"), payload.get("available"))
        elif topic == "app/uninstalled":
            sb.table("tenants").update({"status": "uninstalled"}).eq(
                "id", tenant_id()).execute()
    except Exception:
        log.exception("webhook handling failed topic=%s", topic)
        # 200 anyway: reconcile is the safety net, and retry storms help nobody.
    return jsonify(ok=True), 200


# ===================================================================== cart
@app.post("/api/cart/build")
def cart_build():
    """Build a Shopify cart for a resolved session.

    Order matters and is the whole point:
      1. live re-fetch from Shopify for exactly this session's SKUs
      2. write the mirror
      3. revalidate_session()  -> demotes only changed lines
      4. if anything changed, return 409 with those lines; siblings keep
         their confirmed state and are NOT discarded
      5. build_cart_lines()    -> the seven gate blocks
      6. cartCreate            -> checkoutUrl
    """
    body = request.get_json(silent=True) or {}
    session_id = body.get("session_id")
    if not session_id:
        return jsonify(error="session_id required"), 400
    tid = tenant_id()

    lines = sb.table("bom_lines").select(
        "id, line_no, chosen_product_id").eq("session_id", session_id).eq(
        "gate_state", "confirmed").execute().data
    if not lines:
        return jsonify(error="no confirmed lines in session"), 400

    pids = [l["chosen_product_id"] for l in lines if l["chosen_product_id"]]
    prods = sb.table("products").select("id, sku").in_("id", pids).execute().data
    skus = [p["sku"] for p in prods]

    # 1-2. Shopify is the authority at this instant, not our mirror.
    try:
        _upsert_mirror(shop.fetch_variants_by_sku(skus), "cart_build")
    except shop.ShopifyError as e:
        log.exception("cart revalidation fetch failed")
        return jsonify(error="could not verify availability with Shopify",
                       detail=str(e)), 503

    # 3. Enforcement lives in Postgres.
    verdicts = sb.rpc("revalidate_session", {"p_session": session_id}).execute().data or []
    changed = [v for v in verdicts if v["verdict"] != "ok"]
    if changed:
        return jsonify(status="review_required", changed_lines=changed,
                       unaffected=[v for v in verdicts if v["verdict"] == "ok"]), 409

    # 4-5. build_cart_lines raises if any gate block trips.
    try:
        cart_lines = sb.rpc("build_cart_lines", {"p_session": session_id}).execute().data or []
    except Exception as e:
        log.exception("cart gate refused")
        return jsonify(error="cart gate refused", detail=str(e)[:300]), 409
    if not cart_lines:
        return jsonify(error="no cartable lines"), 409

    payload = [{"merchandiseId": c["variant_gid"], "quantity": int(c["quantity"]),
                "attributes": [{"key": "_jwyn_sku", "value": c["sku"]},
                               {"key": "_jwyn_session", "value": str(session_id)}]}
               for c in cart_lines]
    try:
        checkout_url = shop.create_cart(
            payload, [{"key": "_jwyn_session", "value": str(session_id)}])
    except shop.ShopifyError as e:
        return jsonify(error="cart creation failed", detail=str(e)), 502

    sb.table("carts_created").insert({
        "tenant_id": tid, "session_id": session_id,
        "checkout_url": checkout_url, "line_count": len(cart_lines)}).execute()
    return jsonify(status="ok", checkout_url=checkout_url,
                   lines=len(cart_lines))


@app.get("/health")
def health():
    return jsonify(ok=True, service="jwyn", tenant=TENANT_KEY)
