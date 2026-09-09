/**
 * Database access. Commerce rules live in Postgres (generated columns,
 * build_cart_lines, revalidate_session) so every code path inherits them.
 * Nothing here re-implements them.
 */
import { createClient } from "@supabase/supabase-js";
import type { VariantMirror } from "./shopify.mts";

export const sb = createClient(
  process.env.JWYN_SUPABASE_URL!,
  process.env.JWYN_SUPABASE_SERVICE_KEY!,
  { auth: { persistSession: false } },
);

const TENANT_KEY = process.env.JWYN_TENANT_KEY ?? "jinusgarage";
let cachedTenant: string | null = null;

export async function tenantId(): Promise<string> {
  if (cachedTenant) return cachedTenant;
  const { data, error } = await sb
    .from("tenants").select("id").eq("tenant_key", TENANT_KEY).single();
  if (error) throw new Error(`tenant lookup failed: ${error.message}`);
  cachedTenant = data!.id as string;
  return cachedTenant;
}

export interface UpsertResult {
  matched: number;
  unknownInShopify: number;
  missingFromShopify: number;
}

/**
 * Write Shopify's truth onto matching SKUs. Keyed strictly by SKU.
 *
 * `expectedSkus` is optional and only passed by a FULL reconcile. A SKU we
 * hold that Shopify did not return gets a sync error, which drops it to
 * commerce_state 'unknown' and makes it unconfirmable. Silence from Shopify
 * is not evidence of availability.
 */
export async function upsertMirror(
  found: VariantMirror[],
  source: string,
  expectedSkus?: string[],
): Promise<UpsertResult> {
  const tid = await tenantId();
  const now = new Date().toISOString();
  const logs: Record<string, unknown>[] = [];
  let matched = 0, unknownInShopify = 0, missingFromShopify = 0;

  for (const v of found) {
    const { data } = await sb.from("products").update({
      shopify_product_gid: v.shopify_product_gid,
      shopify_variant_gid: v.shopify_variant_gid,
      shopify_status: v.shopify_status,
      online_store_published: v.online_store_published,
      shopify_inventory_qty: v.shopify_inventory_qty,
      shopify_synced_at: now,
      shopify_sync_error: null,
      sync_status: "synced",
      last_synced_at: now,
    }).eq("tenant_id", tid).eq("sku", v.sku).select("id");

    if (data && data.length) {
      matched++;
      logs.push({ tenant_id: tid, source, sku: v.sku, outcome: "matched" });
    } else {
      unknownInShopify++;
      logs.push({
        tenant_id: tid, source, sku: v.sku, outcome: "in_shopify_not_in_jwyn",
        detail: "SKU present in Shopify, absent from catalogue",
      });
    }
  }

  if (expectedSkus?.length) {
    const returned = new Set(found.map((f) => f.sku));
    for (const sku of expectedSkus.filter((s) => !returned.has(s))) {
      missingFromShopify++;
      await sb.from("products").update({
        shopify_sync_error: "not returned by Shopify in this run",
        shopify_synced_at: now,
        sync_status: "error",
      }).eq("tenant_id", tid).eq("sku", sku);
      logs.push({
        tenant_id: tid, source, sku, outcome: "in_jwyn_not_in_shopify",
        detail: "SKU present in catalogue, absent from Shopify",
      });
    }
  }

  if (logs.length) await sb.from("shopify_sync_log").insert(logs);
  return { matched, unknownInShopify, missingFromShopify };
}

export async function commerceStateCounts(): Promise<Record<string, number>> {
  const tid = await tenantId();
  const { data } = await sb.from("products").select("commerce_state").eq("tenant_id", tid);
  const counts: Record<string, number> = {};
  for (const r of data ?? []) {
    const k = (r as any).commerce_state as string;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
