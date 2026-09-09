/**
 * POST /api/cart/build  { session_id }
 *
 * Order matters and is the whole point:
 *   1. live re-fetch from Shopify for exactly this session's SKUs
 *   2. write the mirror
 *   3. revalidate_session()  -> demotes ONLY changed lines
 *   4. any change -> 409 with those lines; siblings keep confirmed state
 *      and are NOT discarded
 *   5. build_cart_lines()    -> the gate blocks
 *   6. cartCreate            -> checkoutUrl
 *
 * Cart-time revalidation is the final authority even once webhooks are live.
 */
import type { Config, Context } from "@netlify/functions";
import { sb, tenantId, upsertMirror, json } from "../lib/db.mts";
import { fetchVariantsBySku, createCart, ShopifyError } from "../lib/shopify.mts";

export default async (req: Request, _ctx: Context) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const body = await req.json().catch(() => ({}));
  const sessionId = (body as any).session_id;
  if (!sessionId) return json({ error: "session_id required" }, 400);

  const tid = await tenantId();

  const { data: lines } = await sb.from("bom_lines")
    .select("id, line_no, chosen_product_id")
    .eq("session_id", sessionId).eq("gate_state", "confirmed");
  if (!lines?.length) return json({ error: "no confirmed lines in session" }, 400);

  const pids = lines.map((l: any) => l.chosen_product_id).filter(Boolean);
  const { data: prods } = await sb.from("products").select("id, sku").in("id", pids);
  const skus = (prods ?? []).map((p: any) => p.sku);

  // 1-2. Shopify is the authority at this instant, not our mirror.
  try {
    const found = await fetchVariantsBySku(skus);
    await upsertMirror([...found.values()], "cart_build");
  } catch (e) {
    // Never fall back to the mirror here: that is precisely the staleness
    // this step exists to prevent. No verification, no cart.
    return json({
      error: "could not verify availability with Shopify",
      detail: String(e).slice(0, 300),
    }, 503);
  }

  // 3. Enforcement lives in Postgres.
  const { data: verdicts, error: revErr } =
    await sb.rpc("revalidate_session", { p_session: sessionId });
  if (revErr) return json({ error: "revalidation failed", detail: revErr.message }, 500);

  const changed = (verdicts ?? []).filter((v: any) => v.verdict !== "ok");
  if (changed.length) {
    return json({
      status: "review_required",
      changed_lines: changed,
      unaffected: (verdicts ?? []).filter((v: any) => v.verdict === "ok"),
    }, 409);
  }

  // 4-5. build_cart_lines raises if any gate block trips.
  const { data: cartLines, error: gateErr } =
    await sb.rpc("build_cart_lines", { p_session: sessionId });
  if (gateErr) return json({ error: "cart gate refused", detail: gateErr.message }, 409);
  if (!cartLines?.length) return json({ error: "no cartable lines" }, 409);

  const payload = cartLines.map((c: any) => ({
    merchandiseId: c.variant_gid,
    quantity: Number(c.quantity),
    attributes: [
      { key: "_jwyn_sku", value: c.sku },
      { key: "_jwyn_session", value: String(sessionId) },
    ],
  }));

  let checkoutUrl: string;
  try {
    checkoutUrl = await createCart(payload, [
      { key: "_jwyn_session", value: String(sessionId) },
    ]);
  } catch (e) {
    const code = e instanceof ShopifyError ? 502 : 500;
    return json({ error: "cart creation failed", detail: String(e).slice(0, 300) }, code);
  }

  await sb.from("carts_created").insert({
    tenant_id: tid, session_id: sessionId,
    checkout_url: checkoutUrl, line_count: cartLines.length,
  });

  return json({ status: "ok", checkout_url: checkoutUrl, lines: cartLines.length });
};

export const config: Config = { path: "/api/cart/build" };
