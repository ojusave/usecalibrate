#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Manifest } from "./manifest.js";
import { validateManifest } from "./manifest.js";
import { createFirstmile } from "./server.js";

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
  const firstmile = createFirstmile({
    manifest,
    adminToken: requiredEnv("ADMIN_TOKEN"),
    dashboardToken: requiredEnv("DASHBOARD_TOKEN"),
    writeKey: requiredEnv("WRITE_KEY"),
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  });
  const app = new Hono();
  app.route("/", firstmile.routes);

  serve({ fetch: app.fetch, hostname: "0.0.0.0", port }, (info) => {
    process.stderr.write(`firstmile sidecar listening on ${info.address}\n`);
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
