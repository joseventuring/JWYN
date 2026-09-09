"""Shopify Admin + Storefront clients.

Shopify is the commerce source of truth. Everything in this module reads
from Shopify live; nothing here consults the local mirror.
"""
import os, hmac, base64, hashlib, requests

STORE   = os.environ.get("SHOPIFY_STORE", "")
ADMIN   = os.environ.get("SHOPIFY_ADMIN_TOKEN", "")
STORE_T = os.environ.get("SHOPIFY_STOREFRONT_TOKEN", "")
VERSION = os.environ.get("SHOPIFY_API_VERSION", "2026-07")
SECRET  = os.environ.get("SHOPIFY_WEBHOOK_SECRET", "")

ADMIN_URL      = f"https://{STORE}/admin/api/{VERSION}/graphql.json"
STOREFRONT_URL = f"https://{STORE}/api/{VERSION}/graphql.json"


class ShopifyError(RuntimeError):
    pass


def _admin(query, variables=None):
    r = requests.post(ADMIN_URL, timeout=20,
                      headers={"X-Shopify-Access-Token": ADMIN,
                               "Content-Type": "application/json"},
                      json={"query": query, "variables": variables or {}})
    if r.status_code != 200:
        raise ShopifyError(f"admin {r.status_code}: {r.text[:300]}")
    body = r.json()
    if body.get("errors"):
        raise ShopifyError(str(body["errors"])[:300])
    return body["data"]


# --------------------------------------------------------------- catalogue
_VARIANTS = """
query($cursor: String) {
  productVariants(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      id sku inventoryQuantity
      product { id status publishedOnCurrentPublication }
    } }
  }
}"""

def fetch_all_variants():
    """Every variant with its SKU, inventory, product status and publication.

    Returns a dict keyed by SKU. A SKU appearing twice is a merchant data
    error and is reported rather than silently overwritten.
    """
    out, dupes, cursor = {}, [], None
    while True:
        data = _admin(_VARIANTS, {"cursor": cursor})
        conn = data["productVariants"]
        for edge in conn["edges"]:
            n = edge["node"]
            sku = (n.get("sku") or "").strip()
            if not sku:
                continue
            if sku in out:
                dupes.append(sku)
                continue
            p = n["product"]
            out[sku] = {
                "sku": sku,
                "shopify_variant_gid": n["id"],
                "shopify_product_gid": p["id"],
                "shopify_status": p["status"],
                "online_store_published": bool(p["publishedOnCurrentPublication"]),
                "shopify_inventory_qty": n.get("inventoryQuantity") or 0,
            }
        if not conn["pageInfo"]["hasNextPage"]:
            break
        cursor = conn["pageInfo"]["endCursor"]
    return out, dupes


_BY_SKU = """
query($q: String!) {
  productVariants(first: 50, query: $q) {
    edges { node {
      id sku inventoryQuantity
      product { id status publishedOnCurrentPublication }
    } }
  }
}"""

def fetch_variants_by_sku(skus):
    """Live re-fetch for a specific set of SKUs. Used at cart-build time,
    where reading the mirror would only validate staleness."""
    found = {}
    skus = [s for s in skus if s]
    for i in range(0, len(skus), 20):
        chunk = skus[i:i + 20]
        q = " OR ".join(f'sku:"{s}"' for s in chunk)
        data = _admin(_BY_SKU, {"q": q})
        for edge in data["productVariants"]["edges"]:
            n = edge["node"]
            sku = (n.get("sku") or "").strip()
            if sku not in chunk:
                continue
            p = n["product"]
            found[sku] = {
                "sku": sku,
                "shopify_variant_gid": n["id"],
                "shopify_product_gid": p["id"],
                "shopify_status": p["status"],
                "online_store_published": bool(p["publishedOnCurrentPublication"]),
                "shopify_inventory_qty": n.get("inventoryQuantity") or 0,
            }
    return found


# -------------------------------------------------------------------- cart
_CART_CREATE = """
mutation($lines: [CartLineInput!]!, $attrs: [AttributeInput!]) {
  cartCreate(input: {lines: $lines, attributes: $attrs}) {
    cart { id checkoutUrl }
    userErrors { field message }
  }
}"""

def create_cart(lines, attributes=None):
    """lines: [{merchandiseId, quantity, attributes:[{key,value}]}]"""
    if not STORE_T:
        raise ShopifyError("SHOPIFY_STOREFRONT_TOKEN is not set")
    r = requests.post(STOREFRONT_URL, timeout=20,
                      headers={"X-Shopify-Storefront-Access-Token": STORE_T,
                               "Content-Type": "application/json"},
                      json={"query": _CART_CREATE,
                            "variables": {"lines": lines,
                                          "attrs": attributes or []}})
    if r.status_code != 200:
        raise ShopifyError(f"storefront {r.status_code}: {r.text[:300]}")
    body = r.json()
    if body.get("errors"):
        raise ShopifyError(str(body["errors"])[:300])
    res = body["data"]["cartCreate"]
    if res["userErrors"]:
        raise ShopifyError(str(res["userErrors"])[:300])
    return res["cart"]["checkoutUrl"]


# ---------------------------------------------------------------- webhooks
def verify_webhook(raw_body, hmac_header):
    """Constant-time HMAC check. An unverified webhook is discarded, never
    trusted: anyone can POST to a public endpoint."""
    if not SECRET or not hmac_header:
        return False
    digest = hmac.new(SECRET.encode(), raw_body, hashlib.sha256).digest()
    return hmac.compare_digest(base64.b64encode(digest).decode(), hmac_header)
