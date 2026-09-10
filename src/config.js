// src/config.js
// Loads configuration from environment variables (and a local .env file if present).
// Zero dependencies — we parse .env ourselves so the repo stays trivially forkable.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, "..");

/** Minimal .env loader. Only sets keys that aren't already in the environment. */
function loadDotEnv() {
  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // strip surrounding quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv();

export const config = {
  // Instagram API with Instagram Login (graph.instagram.com).
  // Tokens for this API start with "IGA...". If you instead have a Facebook
  // Login / Instagram Graph API token (starts with "EAA..."), set
  // IG_GRAPH_HOST=https://graph.facebook.com to switch hosts.
  igUserId: process.env.IG_USER_ID || "",
  igAccessToken: process.env.IG_ACCESS_TOKEN || "",
  igApiVersion: process.env.IG_API_VERSION || "v22.0",
  igGraphHost: process.env.IG_GRAPH_HOST || "https://graph.instagram.com",

  // Gemini (caption generation)
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",

  // Anthropic (legacy compatibility)
  // Kept here so other parts of the original project do not break.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",

  // Media base URL for relative paths in the queue (optional convenience).
  // If a queue item's media_url is a relative path (e.g. "media/hat.jpg"),
  // it's resolved against this base. Leave blank to require full URLs.
  mediaBaseUrl: process.env.MEDIA_BASE_URL || "",
};

export function requireIgConfig() {
  const missing = [];
  if (!config.igUserId) missing.push("IG_USER_ID");
  if (!config.igAccessToken) missing.push("IG_ACCESS_TOKEN");
  if (missing.length) {
    throw new Error(
      `Missing required env var(s): ${missing.join(", ")}. ` +
        `Set them in .env locally or as GitHub Secrets in CI.`
    );
  }
}

export function requireGeminiConfig() {
  if (!config.geminiApiKey) {
    throw new Error(
      "Missing GEMINI_API_KEY. Set it in .env locally or as a GitHub Secret."
    );
  }
}

export function requireAnthropicConfig() {
  if (!config.anthropicApiKey) {
    throw new Error(
      "Missing ANTHROPIC_API_KEY. Set it in .env locally or as a GitHub Secret."
    );
  }
}
