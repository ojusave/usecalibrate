#!/usr/bin/env node
import { createHash, timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Manifest } from "./manifest.js";
import { validateManifest } from "./manifest.js";
import { createFirstmile } from "./server.js";

function adminAuthorized(header: string | undefined, expected: string): boolean {
  const token = /^Bearer[ \t]+(.+)$/i.exec(header ?? "")?.[1] ?? "";
  const candidate = createHash("sha256").update(token).digest();
  return timingSafeEqual(candidate, createHash("sha256").update(expected).digest());
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer from 1 to 65535");
  }
  return port;
}

async function loadManifest(): Promise<Manifest> {
  const manifestJson = process.env.MANIFEST_JSON;
  const manifestUrl = process.env.MANIFEST_URL;
  if (manifestJson !== undefined) {
    return validateManifest(JSON.parse(manifestJson) as unknown);
  }
  if (manifestUrl !== undefined) {
    const response = await fetch(manifestUrl);
    if (!response.ok) {
      throw new Error(
        `MANIFEST_URL returned ${response.status} ${response.statusText}`,
      );
    }
    return validateManifest(await response.json());
  }
  throw new Error("MANIFEST_JSON or MANIFEST_URL is required");
}

try {
  const port = parsePort(process.env.PORT);
  const manifest = await loadManifest();
  const adminToken = requiredEnv("ADMIN_TOKEN");
  const firstmile = createFirstmile({
    manifest,
    adminToken,
    dashboardToken: requiredEnv("DASHBOARD_TOKEN"),
    writeKey: requiredEnv("WRITE_KEY"),
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  });
  const app = new Hono();
  // Sidecar deployments share the kit's in-memory lifetime, so expose reset here too.
  app.post("/admin/reset", (context) => {
    if (!adminAuthorized(context.req.header("Authorization"), adminToken)) {
      return context.json({ ok: false, error: "unauthorized" }, 401);
    }
    firstmile.reset();
    return context.json({ ok: true });
  });
  app.route("/", firstmile.routes);

  serve({ fetch: app.fetch, hostname: "0.0.0.0", port }, (info) => {
    process.stderr.write(`firstmile sidecar listening on ${info.address}\n`);
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
