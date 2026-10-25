import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const image = process.argv[2] || "openclaw-railway-template:ci";
const suffix = randomUUID();
const name = `openclaw-smoke-${suffix}`;
const volume = `${name}-data`;
const password = randomUUID();
const token = randomUUID();
const auth = `Basic ${Buffer.from(`smoke:${password}`).toString("base64")}`;
const env = ["-e", "PORT=3210", "-e", `SETUP_PASSWORD=${password}`, "-e", `OPENCLAW_GATEWAY_TOKEN=${token}`,
  "-e", "OPENCLAW_MIGRATION=2026.10.7-from-prejuly"];
let started = false;

function docker(args, { allowFailure = false, timeout = 180_000 } = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 });
  if (!allowFailure) {
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout || "Docker command failed");
  }
  return result.stdout?.trim() || "";
}
function inContainer(script) {
  return docker(["exec", name, "node", "--input-type=module", "-e", script]);
}
async function ready(base) {
  const deadline = Date.now() + 300_000;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/setup/healthz`, { signal: AbortSignal.timeout(5_000) });
      const data = await res.json();
      last = JSON.stringify(data);
      if (res.ok && data.ok === true) return;
    } catch (error) { last = error.message; }
    assert.equal(docker(["inspect", "--format", "{{.State.Running}}", name]), "true", "Wrapper exited");
    await delay(1_000);
  }
  throw new Error(`Wrapper/gateway readiness timed out: ${last}`);
}
async function check(base) {
  await ready(base);
  assert.equal((await fetch(`${base}/setup`)).status, 401);
  assert.equal((await fetch(`${base}/openclaw`)).status, 401);
  assert.equal((await fetch(`${base}/control-ui-config.json`)).status, 401);
  const setup = await fetch(`${base}/setup`, { headers: { authorization: auth } });
  assert.equal(setup.status, 200);
  assert.ok((await setup.text()).includes("OpenClaw"));
  const ui = await fetch(`${base}/openclaw/`, { headers: { authorization: auth } });
  assert.equal(ui.status, 200);
  const html = await ui.text();
  assert.ok(html.toLowerCase().includes("<html"));
  const bootstrap = await fetch(`${base}/control-ui-config.json`, { headers: { authorization: auth } });
  assert.equal(bootstrap.status, 200, "Authenticated browser must be able to bootstrap the Control UI");
  assert.match(bootstrap.headers.get("content-type") || "", /application\/json/);
  const bootstrapConfig = await bootstrap.json();
  assert.equal(typeof bootstrapConfig.serverVersion, "string");
  assert.ok(bootstrapConfig.serverVersion.length > 0);
  assert.equal(typeof bootstrapConfig.basePath, "string");
  const scriptSrc = html.match(/<script\b[^>]*\bsrc="([^"]+\.js)"/i)?.[1];
  assert.ok(scriptSrc, "Control UI HTML must reference its compiled JavaScript");
  const assetUrl = new URL(scriptSrc, ui.url);
  assert.equal(assetUrl.origin, new URL(base).origin, "UI script must be served by the same protected wrapper");
  const asset = await fetch(assetUrl, { headers: { authorization: auth } });
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type") || "", /javascript/);
  const health = await (await fetch(`${base}/healthz`)).json();
  assert.equal(health.wrapper.configured, true);
  assert.equal(health.gateway.ready, true);
  inContainer(`
    import assert from "node:assert/strict";
    const res = await fetch("http://127.0.0.1:18789/readyz");
    assert.equal(res.status, 200);
    const ready = await res.json();
    assert.equal(ready.ready, true);
    const os = await import("node:os");
    const interfaces = Object.values(os.networkInterfaces()).flat();
    const address = interfaces.find(item => item.family === "IPv4" && !item.internal)?.address;
    assert.ok(address, "Missing container network interface");
    await assert.rejects(fetch("http://" + address + ":18789/readyz", { signal: AbortSignal.timeout(3000) }),
      "Internal gateway must not listen on the container public interface");
  `);
  // This uses OpenClaw's authenticated WebSocket RPC, not only the HTTP probe.
  docker(["exec", name, "openclaw", "health", "--json"], { timeout: 120_000 });
  docker(["exec", name, "openclaw", "config", "validate", "--json"]);
  inContainer(`
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import { createHash } from "node:crypto";
    import { DatabaseSync } from "node:sqlite";
    const root = "/data/backups/openclaw-2026.10.7-from-prejuly";
    const journal = JSON.parse(fs.readFileSync(root + "/journal.json", "utf8"));
    assert.equal(journal.id, "2026.10.7-from-prejuly");
    assert.equal(journal.stage, "complete");
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(journal.archive).mode & 0o777, 0o600);
    assert.equal(createHash("sha256").update(fs.readFileSync(journal.archive)).digest("hex"), journal.archiveSha256);
    assert.equal(fs.readFileSync("/data/workspace/MEMORY.md", "utf8"), "Legacy smoke memory survives migration.");
    const db = new DatabaseSync("/data/.openclaw/agents/main/agent/openclaw-agent.sqlite", { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT value FROM memory_index_meta WHERE key = ?").get("railway_smoke_legacy_import")?.value,
        "fixture-preserved", "Legacy SQLite memory metadata must be imported into the canonical agent store");
    } finally { db.close(); }
    const config = JSON.parse(fs.readFileSync("/data/.openclaw/openclaw.json", "utf8"));
    assert.equal(config.channels.whatsapp.enabled, false);
    assert.equal(config.channels.whatsapp.dmPolicy, "allowlist");
    assert.deepEqual(config.channels.whatsapp.allowFrom, ["+15555550123"]);
    assert.equal(config.channels.whatsapp.groupPolicy, "disabled");
  `);
}

try {
  docker(["volume", "create", volume]);
  // No external network: --version must execute the shipped native artifact.
  docker(["run", "--rm", "--network", "none", "-v", `${volume}:/data`, "--entrypoint", "node", image, "scripts/smoke.js"]);
  console.log("Installation smoke passed (OpenClaw, Control UI, WhatsApp, native Codex).");

  const seed = `
    const fs = require("node:fs");
    const { DatabaseSync } = require("node:sqlite");
    fs.mkdirSync("/data/.openclaw", { recursive: true });
    fs.mkdirSync("/data/workspace", { recursive: true });
    fs.writeFileSync("/data/.openclaw/openclaw.json", JSON.stringify({
      meta: { lastTouchedVersion: "2026.3.8" },
      gateway: { mode: "local", trustedProxies: ["127.0.0.1"],
        auth: { mode: "token", token: process.env.OPENCLAW_GATEWAY_TOKEN },
        controlUi: { allowedOrigins: ["http://localhost:3210"] } },
      agents: { defaults: { workspace: "/data/workspace", model: { primary: "openai-codex/gpt-5.5" } } },
      channels: { whatsapp: { enabled: false, dmPolicy: "allowlist", allowFrom: ["+15555550123"], groupPolicy: "disabled" } }
    }));
    fs.mkdirSync("/data/.openclaw/credentials/whatsapp/default", { recursive: true });
    fs.mkdirSync("/data/.openclaw/agents/main/agent", { recursive: true });
    fs.writeFileSync("/data/workspace/persistence-sentinel.txt", "disposable smoke data");
    fs.writeFileSync("/data/workspace/MEMORY.md", "Legacy smoke memory survives migration.");
    fs.writeFileSync("/data/.openclaw/credentials/whatsapp/default/persistence-sentinel.txt", "no real credentials");
    fs.writeFileSync("/data/.openclaw/agents/main/agent/persistence-sentinel.txt", "no real auth profiles");
    fs.mkdirSync("/data/.openclaw/memory", { recursive: true });
    // Exact pre-July schema from v2026.3.8 src/memory/memory-schema.ts.
    // A metadata sentinel proves import without embeddings or model requests.
    const memoryDb = new DatabaseSync("/data/.openclaw/memory/main.sqlite");
    memoryDb.exec(
      "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);" +
      "CREATE TABLE files (path TEXT PRIMARY KEY, source TEXT NOT NULL DEFAULT 'memory', hash TEXT NOT NULL, mtime INTEGER NOT NULL, size INTEGER NOT NULL);" +
      "CREATE TABLE chunks (id TEXT PRIMARY KEY, path TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'memory', start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, hash TEXT NOT NULL, model TEXT NOT NULL, text TEXT NOT NULL, embedding TEXT NOT NULL, updated_at INTEGER NOT NULL);" +
      "CREATE TABLE embedding_cache (provider TEXT NOT NULL, model TEXT NOT NULL, provider_key TEXT NOT NULL, hash TEXT NOT NULL, embedding TEXT NOT NULL, dims INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (provider,model,provider_key,hash));"
    );
    memoryDb.prepare("INSERT INTO meta (key,value) VALUES (?,?)").run("railway_smoke_legacy_import", "fixture-preserved");
    memoryDb.close();
  `;
  docker(["run", "--rm", "--network", "none", ...env, "-v", `${volume}:/data`, "--entrypoint", "node", image, "-e", seed]);
  docker(["run", "-d", "--name", name, ...env, "-p", "127.0.0.1::3210", "-v", `${volume}:/data`, image]);
  started = true;
  const address = docker(["port", name, "3210/tcp"]).split("\n")[0];
  const base = `http://${address}`;
  await check(base);
  const stateHashScript = `
    import fs from "node:fs";
    import { createHash } from "node:crypto";
    const paths = [
      "/data/.openclaw/agents/main/agent/persistence-sentinel.txt",
      "/data/.openclaw/credentials/whatsapp/default/persistence-sentinel.txt",
      "/data/workspace/persistence-sentinel.txt",
      "/data/workspace/MEMORY.md",
      "/data/backups/openclaw-2026.10.7-from-prejuly/journal.json",
    ];
    const config = JSON.parse(fs.readFileSync("/data/.openclaw/openclaw.json", "utf8"));
    const identity = { workspace: config.agents.defaults.workspace, mode: config.gateway.mode,
      token: config.gateway.auth.token };
    console.log(createHash("sha256").update(JSON.stringify(identity)).update(Buffer.concat(paths.map(p => fs.readFileSync(p)))).digest("hex"));
  `;
  const before = inContainer(stateHashScript);
  docker(["restart", "--time", "30", name]);
  await check(base);
  assert.equal(inContainer(stateHashScript), before, "State changed across container restart");
  console.log("Legacy migration/backup, real gateway/RPC, protected UI bootstrap, injected port and volume restart smoke passed.");
  console.log("No model request or WhatsApp message was sent; those require production account verification.");
} catch (error) {
  // Only disposable test state is used; the generated token is still redacted.
  if (started) {
    const logs = docker(["logs", "--tail", "120", name], { allowFailure: true });
    console.error(logs.split(token).join("[redacted]").split(password).join("[redacted]"));
  }
  throw error;
} finally {
  if (started) docker(["rm", "-f", name], { allowFailure: true });
  docker(["volume", "rm", volume], { allowFailure: true });
}
