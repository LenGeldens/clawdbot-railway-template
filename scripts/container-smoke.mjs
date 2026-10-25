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
const env = ["-e", "PORT=3210", "-e", `SETUP_PASSWORD=${password}`, "-e", `OPENCLAW_GATEWAY_TOKEN=${token}`];
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
  const deadline = Date.now() + 180_000;
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
  const setup = await fetch(`${base}/setup`, { headers: { authorization: auth } });
  assert.equal(setup.status, 200);
  assert.ok((await setup.text()).includes("OpenClaw"));
  const ui = await fetch(`${base}/openclaw/`, { headers: { authorization: auth } });
  assert.equal(ui.status, 200);
  assert.ok((await ui.text()).toLowerCase().includes("<html"));
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
}

try {
  docker(["volume", "create", volume]);
  // No external network: --version must execute the shipped native artifact.
  docker(["run", "--rm", "--network", "none", "-v", `${volume}:/data`, "--entrypoint", "node", image, "scripts/smoke.js"]);
  console.log("Installation smoke passed (OpenClaw, Control UI, WhatsApp, native Codex).");

  const seed = `
    const fs = require("node:fs");
    fs.mkdirSync("/data/.openclaw", { recursive: true });
    fs.mkdirSync("/data/workspace", { recursive: true });
    fs.writeFileSync("/data/.openclaw/openclaw.json", JSON.stringify({
      gateway: { mode: "local", auth: { mode: "token", token: process.env.OPENCLAW_GATEWAY_TOKEN },
        controlUi: { allowedOrigins: ["http://localhost:3210"] } },
      agents: { defaults: { workspace: "/data/workspace" } }
    }));
    fs.mkdirSync("/data/.openclaw/credentials/whatsapp/default", { recursive: true });
    fs.mkdirSync("/data/.openclaw/agents/main/agent", { recursive: true });
    fs.writeFileSync("/data/workspace/persistence-sentinel.txt", "disposable smoke data");
    fs.writeFileSync("/data/.openclaw/credentials/whatsapp/default/persistence-sentinel.txt", "no real credentials");
    fs.writeFileSync("/data/.openclaw/agents/main/agent/persistence-sentinel.txt", "no real auth profiles");
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
  console.log("Real gateway, authenticated RPC, protected HTTP/UI, injected port and volume restart smoke passed.");
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
