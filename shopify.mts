/**
 * Shopify clients. Shopify is the commerce source of truth — nothing in
 * this module consults the local mirror.
 */
import crypto from "node:crypto";

const STORE = process.env.SHOPIFY_STORE ?? "";
const ADMIN = process.env.SHOPIFY_ADMIN_TOKEN ?? "";
const STOREFRONT = process.env.SHOPIFY_STOREFRONT_TOKEN ?? "";
const VERSION = process.env.SHOPIFY_API_VERSION ?? "2026-07";
const SECRET = process.env.SHOPIFY_WEBHOOK_SECRET ?? "";

const ADMIN_URL = `https://${STORE}/admin/api/${VERSION}/graphql.json`;
const STOREFRONT_URL = `https://${STORE}/api/${VERSION}/graphql.json`;

export class ShopifyError extends Error {}

export interface VariantMirror {
  sku: string;
  shopify_product_gid: string;
  shopify_variant_gid: string;
  shopify_status: string;
  online_store_published: boolean;
  shopify_inventory_qty: number;
}

async function admin<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(ADMIN_URL, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": ADMIN, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new ShopifyError(`admin ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  if (body.errors) throw new ShopifyError(JSON.stringify(body.errors).slice(0, 300));
  return body.data as T;
}

const VARIANT_FIELDS = `
  id sku inventoryQuantity
  product { id status publishedOnCurrentPublication }`;

function toMirror(node: any): VariantMirror | null {
  const sku = (node.sku ?? "").trim();
  if (!sku) return null;
  return {
    sku,
    shopify_variant_gid: node.id,
    shopify_product_gid: node.product.id,
    shopify_status: node.product.status,
    online_store_published: Boolean(node.product.publishedOnCurrentPublication),
    shopify_inventory_qty: node.inventoryQuantity ?? 0,
  };
}

/**
 * One page of variants. Paged deliberately rather than looped to exhaustion:
 * a serverless function has a wall-clock budget, and a 5,000-SKU client
 * catalogue must not turn one invocation into a timeout. The caller resumes
 * from `cursor` on the next run.
 */
export async function fetchVariantPage(
  cursor: string | null,
  pageSize = 100,
): Promise<{ found: VariantMirror[]; duplicates: string[]; nextCursor: string | null }> {
  const data = await admin<any>(
    `query($cursor:String,$n:Int!){ productVariants(first:$n, after:$cursor){
        pageInfo{ hasNextPage endCursor } edges{ node{ ${VARIANT_FIELDS} } } } }`,
    { cursor, n: pageSize },
  );
  const conn = data.productVariants;
  const seen = new Set<string>();
  const found: VariantMirror[] = [];
  const duplicates: string[] = [];
  for (const edge of conn.edges) {
    const m = toMirror(edge.node);
    if (!m) continue;
    if (seen.has(m.sku)) { duplicates.push(m.sku); continue; }
    seen.add(m.sku);
    found.push(m);
  }
  return {
    found,
    duplicates,
    nextCursor: conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null,
  };
}

/** Live re-fetch for specific SKUs. Used at cart-build time, where reading
 *  the mirror would only validate staleness. */
export async function fetchVariantsBySku(skus: string[]): Promise<Map<string, VariantMirror>> {
  const out = new Map<string, VariantMirror>();
  const wanted = skus.filter(Boolean);
  for (let i = 0; i < wanted.length; i += 20) {
    const chunk = wanted.slice(i, i + 20);
    const q = chunk.map((s) => `sku:"${s.replace(/"/g, '\\"')}"`).join(" OR ");
    const data = await admin<any>(
      `query($q:String!){ productVariants(first:50, query:$q){ edges{ node{ ${VARIANT_FIELDS} } } } }`,
      { q },
    );
    for (const edge of data.productVariants.edges) {
      const m = toMirror(edge.node);
      if (m && chunk.includes(m.sku)) out.set(m.sku, m);
    }
  }
  return out;
}

export interface CartLineInput {
  merchandiseId: string;
  quantity: number;
  attributes?: { key: string; value: string }[];
}

export async function createCart(
  lines: CartLineInput[],
  attributes: { key: string; value: string }[] = [],
): Promise<string> {
  if (!STOREFRONT) throw new ShopifyError("SHOPIFY_STOREFRONT_TOKEN is not set");
  const res = await fetch(STOREFRONT_URL, {
    method: "POST",
    headers: {
      "X-Shopify-Storefront-Access-Token": STOREFRONT,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `mutation($lines:[CartLineInput!]!,$attrs:[AttributeInput!]){
        cartCreate(input:{lines:$lines, attributes:$attrs}){
          cart{ id checkoutUrl } userErrors{ field message } } }`,
      variables: { lines, attrs: attributes },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new ShopifyError(`storefront ${res.status}`);
  const body = await res.json();
  if (body.errors) throw new ShopifyError(JSON.stringify(body.errors).slice(0, 300));
  const r = body.data.cartCreate;
  if (r.userErrors?.length) throw new ShopifyError(JSON.stringify(r.userErrors).slice(0, 300));
  return r.cart.checkoutUrl as string;
}

/** Constant-time HMAC check. An unverified webhook is discarded, never
 *  trusted: anyone can POST to a public endpoint. */
export function verifyWebhook(rawBody: string, header: string | null): boolean {
  if (!SECRET || !header) return false;
  const digest = crypto.createHmac("sha256", SECRET).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
