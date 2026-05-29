#!/usr/bin/env node
/**
 * Lightweight CI guard that the published `payload.schema.json` and the
 * exported TypeScript `WebhookPayload` stay in lockstep.
 *
 * We deliberately avoid pulling in `ajv` or any other runtime
 * dependency: the schema is authored by hand for readability, and a
 * dependency-free walker is enough to catch the realistic drift
 * scenarios — adding a TS field but forgetting the schema, renaming a
 * property, changing required-ness, etc.
 *
 * Run this from `bun run check`. It exits non-zero on any drift so
 * the commit can't merge until the two are aligned.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const schema = JSON.parse(
  readFileSync(resolve(repoRoot, "payload.schema.json"), "utf8"),
);
const indexTs = readFileSync(resolve(repoRoot, "src/index.ts"), "utf8");

const errors = [];

// ---------------------------------------------------------------------------
// 1. Top-level required keys must match between the schema and the TS
//    `WebhookPayload` interface. We extract the interface block by
//    name and pull out required (no `?`) string-typed property names.
// ---------------------------------------------------------------------------

function extractInterfaceBody(source, name) {
  // Grabs the body between the first `{` after `interface <name>`
  // (taking the angle-bracket generic into account) and its matching
  // closing `}`. Handles nested braces by counting depth.
  const re = new RegExp(`interface\\s+${name}(?:<[^>]*>)?\\s*{`, "m");
  const match = re.exec(source);
  if (!match) return null;
  let depth = 1;
  let i = match.index + match[0].length;
  const start = i;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  return source.slice(start, i - 1);
}

function parseProps(body) {
  // Returns Map<name, { optional, raw }>. Skips JSDoc and nested
  // object literals (we only care about top-level property names).
  const props = new Map();
  if (!body) return props;
  const cleaned = body
    .replace(/\/\*\*[\s\S]*?\*\//g, "") // strip JSDoc blocks
    .replace(/\/\/.*$/gm, ""); // strip line comments
  const lines = cleaned.split("\n");
  let depth = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    // Track nested-object depth so `data: { articles: ... }` doesn't
    // surface its inner keys as top-level properties.
    const opens = (line.match(/{/g) || []).length;
    const closes = (line.match(/}/g) || []).length;
    if (depth === 0) {
      const m = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*(\?)?\s*:/.exec(line);
      if (m) {
        props.set(m[1], { optional: m[2] === "?", raw: line });
      }
    }
    depth += opens - closes;
    if (depth < 0) depth = 0;
  }
  return props;
}

const payloadBody = extractInterfaceBody(indexTs, "WebhookPayload");
const articleBody = extractInterfaceBody(indexTs, "WebhookArticle");

if (!payloadBody) errors.push("Could not find `interface WebhookPayload` in src/index.ts.");
if (!articleBody) errors.push("Could not find `interface WebhookArticle` in src/index.ts.");

if (payloadBody && articleBody) {
  const tsPayloadProps = parseProps(payloadBody);
  const tsArticleProps = parseProps(articleBody);

  const schemaPayloadProps = new Set(Object.keys(schema.properties || {}));
  const schemaPayloadRequired = new Set(schema.required || []);
  const schemaArticleProps = new Set(
    Object.keys(schema.$defs?.Article?.properties || {}),
  );
  const schemaArticleRequired = new Set(schema.$defs?.Article?.required || []);

  for (const [name, { optional }] of tsPayloadProps) {
    if (!schemaPayloadProps.has(name)) {
      errors.push(`WebhookPayload.${name} exists in TS but not in payload.schema.json#/properties`);
      continue;
    }
    const schemaRequired = schemaPayloadRequired.has(name);
    if (!optional && !schemaRequired) {
      errors.push(`WebhookPayload.${name} is required in TS but optional in schema`);
    }
    if (optional && schemaRequired) {
      errors.push(`WebhookPayload.${name} is optional in TS but required in schema`);
    }
  }
  for (const name of schemaPayloadProps) {
    if (!tsPayloadProps.has(name)) {
      errors.push(`payload.schema.json#/properties/${name} has no corresponding field in TS WebhookPayload`);
    }
  }

  for (const [name, { optional }] of tsArticleProps) {
    if (!schemaArticleProps.has(name)) {
      errors.push(`WebhookArticle.${name} exists in TS but not in payload.schema.json#/$defs/Article/properties`);
      continue;
    }
    const schemaRequired = schemaArticleRequired.has(name);
    if (!optional && !schemaRequired) {
      errors.push(`WebhookArticle.${name} is required in TS but optional in schema`);
    }
    if (optional && schemaRequired) {
      errors.push(`WebhookArticle.${name} is optional in TS but required in schema`);
    }
  }
  for (const name of schemaArticleProps) {
    if (!tsArticleProps.has(name)) {
      errors.push(`payload.schema.json#/$defs/Article/properties/${name} has no corresponding field in TS WebhookArticle`);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. The `event_type` enum in the schema must exactly match the
//    `WEBHOOK_EVENT_TYPE_SET` literal in src/index.ts. Anything that
//    drifts here is a guaranteed customer footgun.
// ---------------------------------------------------------------------------

const setRe = /WEBHOOK_EVENT_TYPE_SET\s*=\s*new\s+Set<string>\(\[([\s\S]*?)\]\)/m;
const setMatch = setRe.exec(indexTs);
if (!setMatch) {
  errors.push("Could not find WEBHOOK_EVENT_TYPE_SET in src/index.ts.");
} else {
  const tsEvents = new Set(
    setMatch[1]
      .split(",")
      .map((s) => s.trim().replace(/^["']|["'],?$/g, ""))
      .filter(Boolean),
  );
  const schemaEvents = new Set(schema.properties.event_type.enum);
  for (const evt of tsEvents) {
    if (!schemaEvents.has(evt)) {
      errors.push(`event_type "${evt}" exists in TS but not in schema enum`);
    }
  }
  for (const evt of schemaEvents) {
    if (!tsEvents.has(evt)) {
      errors.push(`event_type "${evt}" exists in schema enum but not in TS`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Each schema example must satisfy the same fields the TS parser
//    would require. Validates the docs ship valid samples without
//    pulling in ajv.
// ---------------------------------------------------------------------------

for (const [i, example] of (schema.examples || []).entries()) {
  for (const required of schema.required) {
    if (!(required in example)) {
      errors.push(`schema.examples[${i}] missing required key "${required}"`);
    }
  }
  if (!Array.isArray(example?.data?.articles)) {
    errors.push(`schema.examples[${i}].data.articles must be an array`);
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (errors.length > 0) {
  console.error("\u2717 payload.schema.json drift detected:\n");
  for (const e of errors) console.error("  - " + e);
  console.error(
    "\nKeep payload.schema.json in lockstep with WebhookPayload / WebhookArticle / WEBHOOK_EVENT_TYPE_SET in src/index.ts.",
  );
  process.exit(1);
}

console.log("\u2713 payload.schema.json is in sync with src/index.ts.");
