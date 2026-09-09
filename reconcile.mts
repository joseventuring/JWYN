/**
 * Full SKU reconciliation. Recovery for missed webhooks — webhooks are an
 * optimisation, this is what guarantees the mirror converges on Shopify.
 *
 * Runs on a schedule (netlify.toml) and on demand with X-JWYN-Run-Secret.
 *
 * Paged with a cursor and a wall-clock budget so a large client catalogue
 * cannot turn one invocation into a timeout. An unfinished run returns its
 * cursor and is resumed by the next call.
 */
import type { Config, Context } from "@netlify/functions";
import { sb, tenantId, upsertMirror, commerceStateCounts, json } from "../lib/db.mts";
import { fetchVariantPage } from "../lib/shopify.mts";

const BUDGET_MS = 7_000; // leave headroom inside the 10s function limit

export default async (req: Request, _ctx: Context) => {
  const secret = process.env.JWYN_RUN_SECRET ?? "";
  const isScheduled = req.headers.get("X-Nf-Event") === "schedule";
  if (!isScheduled) {
    if (!secret || req.headers.get("X-JWYN-Run-Secret") !== secret) {
      return json({ error: "unauthorised" }, 401);
    }
  }

  const url = new URL(req.url);
  let cursor = url.searchParams.get("cursor");
  const started = Date.now();

  const tid = await tenantId();
  const { data: held } = await sb.from("products").select("sku").eq("tenant_id", tid);
  const heldSkus = (held ?? []).map((r: any) => r.sku);

  const seen: string[] = [];
  const duplicates: string[] = [];
  let matched = 0, unknownInShopify = 0, pages = 0, complete = false;

  while (Date.now() - started < BUDGET_MS) {
    const page = await fetchVariantPage(cursor);
    pages++;
    duplicates.push(...page.duplicates);
    seen.push(...page.found.map((f) => f.sku));
    const r = await upsertMirror(page.found, "reconcile");
    matched += r.matched;
    unknownInShopify += r.unknownInShopify;
    cursor = page.nextCursor;
    if (!cursor) { complete = true; break; }
  }

  // Only a COMPLETE sweep may mark SKUs missing. A partial run has not seen
  // the whole catalogue, and flagging absence from partial evidence would
  // wrongly push live products to 'unknown'.
  let missingFromShopify = 0;
  if (complete) {
    const r = await upsertMirror([], "reconcile", heldSkus.filter((s) => !seen.includes(s)));
    missingFromShopify = r.missingFromShopify;
  }

  return json({
    complete,
    pages,
    next_cursor: complete ? null : cursor,
    shopify_variants_seen: seen.length,
    duplicate_skus: duplicates,
    matched,
    in_shopify_not_in_jwyn: unknownInShopify,
    in_jwyn_not_in_shopify: missingFromShopify,
    states: complete ? await commerceStateCounts() : undefined,
  });
};

export const config: Config = { path: "/api/reconcile" };
