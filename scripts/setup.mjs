#!/usr/bin/env node
// One-command setup for your own copy:
//   1. makes sure you're logged in to Cloudflare
//   2. creates the D1 database in *your* account (or reuses it) and writes its id into wrangler.jsonc
//   3. creates the tables
//   4. deploys the worker
// Safe to re-run at any time.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const CONFIG = new URL("../wrangler.jsonc", import.meta.url);

const run = (cmd, env = {}) => execSync(cmd, { stdio: "inherit", env: { ...process.env, ...env } });
const capture = (cmd) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const step = (msg) => console.log(`\n\x1b[1m👀 ${msg}\x1b[0m`);

function fail(msg) {
  console.error(`\n\x1b[31m✘ ${msg}\x1b[0m`);
  process.exit(1);
}

step("Checking your Cloudflare login");
let whoami = "";
try {
  whoami = capture("npx wrangler whoami");
} catch {}
if (!/logged in/i.test(whoami)) {
  console.log("Not logged in yet — opening the browser so you can sign in (free account is fine).");
  run("npx wrangler login");
}

step("Setting up the D1 database");
let config = readFileSync(CONFIG, "utf8");
const name = config.match(/"database_name":\s*"([^"]+)"/)?.[1];
const currentId = config.match(/"database_id":\s*"([^"]*)"/)?.[1];
if (!name) fail("Couldn't find database_name in wrangler.jsonc");

let databases;
try {
  databases = JSON.parse(capture("npx wrangler d1 list --json"));
} catch (e) {
  fail(
    `Couldn't list your D1 databases.\n${e.stderr || e.message}\n` +
      "If your login has several Cloudflare accounts, pick one: CLOUDFLARE_ACCOUNT_ID=<id> npm run setup",
  );
}

let db = databases.find((d) => d.uuid === currentId) ?? databases.find((d) => d.name === name);
if (db) {
  console.log(`Using existing database "${db.name}" (${db.uuid}).`);
} else {
  let out;
  try {
    out = capture(`npx wrangler d1 create ${name}`);
  } catch (e) {
    const err = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    if (/maximum number of D1 databases/i.test(err)) {
      fail("Your account has hit the free plan's D1 database limit (10). Delete an unused one in the dashboard and re-run.");
    }
    fail(`Creating the database failed:\n${err || e.message}`);
  }
  const id = out.match(/"database_id":\s*"([0-9a-f-]{36})"/)?.[1];
  if (!id) fail(`Created the database but couldn't read its id from:\n${out}`);
  db = { name, uuid: id };
  console.log(`Created database "${name}" (${id}).`);
}

if (db.uuid !== currentId) {
  config = config.replace(/("database_id":\s*")[^"]*(")/, `$1${db.uuid}$2`);
  writeFileSync(CONFIG, config);
  console.log("Saved the database id to wrangler.jsonc.");
}

step("Creating tables");
run("npx wrangler d1 migrations apply DB --remote", { CI: "true" });

step("Deploying");
run("npx wrangler deploy");

console.log(
  "\n\x1b[32m✔ Done!\x1b[0m Open the workers.dev URL above, paste a channel @handle into “Quick add channel”, and you're watching.\n" +
    "  Tip: there's no login on the app — see “Keep it private” in the README.\n",
);
