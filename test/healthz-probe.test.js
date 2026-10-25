import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const setupPassword = "fixture-setup-password";
const authorization = `Basic ${Buffer.from(`admin:${setupPassword}`).toString("base64")}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stateCleanups = new Map();

// This CLI only touches the temporary test state and loopback HTTP server. It
// cannot authenticate to a provider or create an actual messaging connection.
const fixtureCli = `
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
const state = process.env.OPENCLAW_STATE_DIR;
const args = process.argv.slice(2);
const configPath = path.join(state, "openclaw.json");
if (args[0] === "config" && args[1] === "set") {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const keys = args[2].split(".");
  let target = config;
  for (const key of keys.slice(0, -1)) target = target[key] ??= {};
  target[keys.at(-1)] = args[3];
  fs.writeFileSync(configPath, JSON.stringify(config));
} else if (args[0] === "gateway") {
  fs.writeFileSync(path.join(state, "fixture.pid"), String(process.pid));
  const server = http.createServer((req, res) => {
    const mode = fs.readFileSync(path.join(state, "fixture-mode"), "utf8");
    if (req.url !== "/readyz") return res.end("fixture control UI");
    if (mode === "hang") return;
    if (mode === "redirect") {
      res.writeHead(302, { Location: "/" });
      return res.end();
    }
    if (mode === "html") return res.end("<html>login page</html>");
    if (mode === "malformed") return res.end("{broken");
    res.setHeader("Content-Type", "application/json");
    res.statusCode = mode === "unhealthy" || mode === "bad-status" ? 503 : 200;
    res.end(JSON.stringify({
      ready: mode === "ready" || mode === "bad-status" ? true : mode === "truthy" ? "true" : false,
      privateDiagnostic: "fixture-secret-must-not-be-public"
    }));
  });
  server.listen(Number(process.env.INTERNAL_GATEWAY_PORT), "127.0.0.1");
  process.on("SIGTERM", () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
} else {
  console.log("fixture CLI");
}
`;

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function eventually(check, message, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < until) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(message, { cause: lastError });
}

async function makeState(t, configured) {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wrapper-test-"));
  const cleanups = [];
  stateCleanups.set(state, cleanups);
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    stateCleanups.delete(state);
    await fs.rm(state, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(state, "fixture.mjs"), fixtureCli);
  await fs.writeFile(path.join(state, "fixture-mode"), "unhealthy");
  if (configured) {
    await fs.writeFile(path.join(state, "openclaw.json"), JSON.stringify({
      gateway: { mode: "local" },
      testSentinel: "preserve existing config",
    }));
    await fs.mkdir(path.join(state, "workspace"));
    await fs.writeFile(path.join(state, "workspace", "notes.md"), "preserve workspace");
  }
  return state;
}

async function startWrapper(t, state) {
  const port = await freePort();
  const gatewayPort = await freePort();
  const fallbackPort = await freePort();
  // Do not inherit provider keys, OpenClaw state overrides or real credentials.
  const env = Object.fromEntries(["PATH", "SystemRoot", "TEMP", "TMP", "HOME"]
    .filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  const proc = spawn(process.execPath, ["src/server.js"], {
    cwd: root,
    env: {
      ...env,
      PORT: String(port),
      OPENCLAW_PUBLIC_PORT: String(fallbackPort),
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_WORKSPACE_DIR: path.join(state, "workspace"),
      OPENCLAW_ENTRY: path.join(state, "fixture.mjs"),
      OPENCLAW_NODE: process.execPath,
      INTERNAL_GATEWAY_PORT: String(gatewayPort),
      INTERNAL_GATEWAY_HOST: "127.0.0.1",
      SETUP_PASSWORD: setupPassword,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  proc.stdout.on("data", (chunk) => { output += chunk; });
  proc.stderr.on("data", (chunk) => { output += chunk; });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    // Windows SIGTERM terminates the wrapper directly, so clean its fixture
    // child explicitly as well. The PID belongs only to this temporary state.
    try {
      const pid = Number(await fs.readFile(path.join(state, "fixture.pid"), "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid);
    } catch {}
    if (proc.exitCode === null && proc.signalCode === null) {
      const exited = once(proc, "exit");
      proc.kill();
      await exited;
    }
    await fs.rm(path.join(state, "fixture.pid"), { force: true });
  };
  stateCleanups.get(state).push(stop);
  const request = (url, options = {}) => fetch(`http://127.0.0.1:${port}${url}`, {
    signal: AbortSignal.timeout(5_000),
    ...options,
  });
  await eventually(async () => {
    if (proc.exitCode !== null) throw new Error(output);
    return await request("/setup/healthz");
  }, `Wrapper did not listen on PORT (${port}): ${output}`);
  return { request, stop, state, output: () => output };
}

async function assertHealth(wrapper, { configured, ready, status }) {
  for (const url of ["/setup/healthz", "/healthz"]) {
    const response = await wrapper.request(url);
    assert.equal(response.status, status, url);
    assert.equal(response.headers.get("cache-control"), "no-store");
    // Exact shape also proves diagnostics, file paths and tokens stay private.
    assert.deepEqual(await response.json(), {
      ok: status === 200,
      wrapper: { configured },
      gateway: { ready },
    });
  }
}

test("fresh wrapper honors PORT, permits health probes, and protects setup", async (t) => {
  const state = await makeState(t, false);
  const wrapper = await startWrapper(t, state);
  await assertHealth(wrapper, { configured: false, ready: false, status: 200 });
  assert.equal((await wrapper.request("/setup")).status, 401);
  assert.equal((await wrapper.request("/setup/api/config/raw")).status, 401);
  assert.equal((await wrapper.request("/setup", {
    headers: { authorization: `Basic ${Buffer.from("admin:wrong").toString("base64")}` },
  })).status, 401);
  assert.equal((await wrapper.request("/setup", { headers: { authorization } })).status, 200);
  const redirect = await wrapper.request("/", { headers: { authorization }, redirect: "manual" });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "/setup");
  assert.equal((await fs.readFile(path.join(state, "gateway.token"), "utf8")).length, 64);
});

test("configured wrapper waits for actual readiness and preserves state across restart", async (t) => {
  const state = await makeState(t, true);
  let wrapper = await startWrapper(t, state);
  const setMode = (mode) => fs.writeFile(path.join(state, "fixture-mode"), mode);
  await eventually(async () => (await fs.stat(path.join(state, "fixture.pid"))).isFile(),
    "Fixture gateway did not start");
  await assertHealth(wrapper, { configured: true, ready: false, status: 503 });

  // A child process exists, but it is not ready. Proxy requests must wait for
  // the in-flight start rather than treating the process handle as success.
  let proxySettled = false;
  const proxied = wrapper.request("/openclaw", { headers: { authorization } });
  proxied.then(() => { proxySettled = true; }, () => { proxySettled = true; });
  await delay(150);
  assert.equal(proxySettled, false, "startup leaked through to the proxy before readiness");
  await setMode("ready");
  const response = await proxied;
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "fixture control UI");
  await assertHealth(wrapper, { configured: true, ready: true, status: 200 });

  for (const mode of ["unhealthy", "bad-status", "not-ready", "truthy", "html", "malformed", "redirect", "hang"]) {
    await t.test(`does not report ready for ${mode}`, async () => {
      await setMode(mode);
      await assertHealth(wrapper, { configured: true, ready: false, status: 503 });
    });
  }
  await setMode("ready");
  await assertHealth(wrapper, { configured: true, ready: true, status: 200 });

  const token = await fs.readFile(path.join(state, "gateway.token"), "utf8");
  process.kill(Number(await fs.readFile(path.join(state, "fixture.pid"), "utf8")));
  await eventually(() => wrapper.output().includes("[gateway] exited"), "Fixture child did not exit");
  await assertHealth(wrapper, { configured: true, ready: false, status: 503 });
  await wrapper.stop();
  wrapper = await startWrapper(t, state);
  await eventually(() => wrapper.output().includes("[wrapper] gateway ready"), "Restart did not become ready");
  await assertHealth(wrapper, { configured: true, ready: true, status: 200 });
  assert.equal(await fs.readFile(path.join(state, "gateway.token"), "utf8"), token);
  const config = JSON.parse(await fs.readFile(path.join(state, "openclaw.json"), "utf8"));
  assert.equal(config.testSentinel, "preserve existing config");
  assert.equal(config.gateway.auth.token, token);
  assert.equal(config.gateway.remote.token, token);
  assert.equal(await fs.readFile(path.join(state, "workspace", "notes.md"), "utf8"), "preserve workspace");
  assert.equal((await wrapper.request("/setup")).status, 401);
});
