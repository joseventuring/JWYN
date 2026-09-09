import type { Config } from "@netlify/functions";
import { json } from "../lib/db.mts";

export default async () =>
  json({ ok: true, service: "jwyn", tenant: process.env.JWYN_TENANT_KEY ?? "jinusgarage" });

export const config: Config = { path: "/api/health" };
