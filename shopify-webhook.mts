/**
 * POST /api/webhooks/shopify
 *
 * HMAC-verified. Handlers stay cheap: Shopify retries on timeout, so slow
 * work belongs in the scheduled reconcile, not here.
 */
import type { Config, Context } from "@netlify/functions";
import { sb, tenantId, upsertMirror, json } from "../lib/db.mts";
import { verifyWebhook, fetchVariantsBySku } from "../lib/shopify.mts";

export default async (req: Request, _ctx: Context) => {
  const raw = await req.text();
  if (!verifyWebhook(raw, req.headers.get("X-Shopify-Hmac-Sha256"))) {
    return json({ error: "invalid hmac" }, 401);
  }

  const topic = req.headers.get("X-Shopify-Topic") ?? "";
  let payload: any = {};
  try { payload = JSON.parse(raw || "{}"); } catch { /* tolerated below */ }

  try {
    if (topic === "products/update" || topic === "products/create") {
      const skus = (payload.variants ?? [])
        .map((v: any) => v.sku).filter(Boolean);
      if (skus.length) {
        const found = await fetchVariantsBySku(skus);
        await upsertMirror([...found.values()], `webhook:${topic}`);
      }
    } else if (topic === "products/delete") {
      await sb.from("products").update({
        shopify_sync_error: "product deleted in Shopify",
        shopify_synced_at: new Date().toISOString(),
        sync_status: "error",
      })
        .eq("tenant_id", await tenantId())
        .eq("shopify_product_gid", `gid://shopify/Product/${payload.id}`);
    } else if (topic === "inventory_levels/update") {
      // The payload carries an inventory_item_id, not a SKU. Resolving it
      // inline needs an extra lookup; a wrong guess here is worse than a
      // slightly delayed refresh, so the scheduled reconcile picks it up.
      console.log("inventory webhook", payload.inventory_item_id, payload.available);
    } else if (topic === "app/uninstalled") {
      await sb.from("tenants").update({ status: "uninstalled" })
        .eq("id", await tenantId());
    }
  } catch (e) {
    // 200 regardless: reconcile is the safety net and retry storms help nobody.
    console.error("webhook handling failed", topic, e);
  }

  return json({ ok: true });
};

export const config: Config = { path: "/api/webhooks/shopify" };
