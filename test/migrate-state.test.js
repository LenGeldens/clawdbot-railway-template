import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { extract } from "tar";
import { migrateState, MIGRATION_ID } from "../scripts/migrate-state.mjs";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-migration-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, ".openclaw");
  const workspaceDir = path.join(root, "workspace");
  await fs.mkdir(path.join(stateDir, "agents", "main"), { recursive: true });
  await fs.mkdir(workspaceDir);
  await fs.writeFile(path.join(stateDir, "openclaw.json"), "{\"original\":true}\n");
  await fs.writeFile(path.join(stateDir, "agents", "main", "state.sqlite"), Buffer.from([0, 1, 2, 255]));
  await fs.writeFile(path.join(stateDir, "agents", "main", "state.sqlite-wal"), "wal retained");
  await fs.writeFile(path.join(stateDir, "agents", "main", "state.sqlite-shm"), "shm retained");
  await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Fixture memory survives.\n");
  const calls = path.join(root, "calls.jsonl");
  const bridgeEntry = path.join(root, "bridge.mjs");
  const entry = path.join(root, "current.mjs");
  for (const [file, version, stage] of [[bridgeEntry, "2026.9.5", "bridge"], [entry, "2026.10.7", "current"]]) {
    await fs.writeFile(file, `import fs from 'node:fs';
import path from 'node:path';
const args=process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_CALLS,JSON.stringify({stage:${JSON.stringify(stage)},args})+'\\n');
if(args[0]==='--version') console.log(process.env.FIXTURE_BAD_VERSION || 'OpenClaw ${version} (fixture)');
else if(args[0]==='doctor') {
 fs.writeFileSync(path.join(process.env.OPENCLAW_STATE_DIR,'openclaw.json'),JSON.stringify({migrated:${JSON.stringify(stage)}}));
 console.log('private-fixture-output-never-public');
 if(process.env.FIXTURE_FAIL_STAGE===${JSON.stringify(stage)}) process.exit(1);
} else if(args[0]==='config' && args[1]==='validate') {
 if(process.env.FIXTURE_FAIL_VALIDATE===${JSON.stringify(stage)}) process.exit(2);
 console.log('{"valid":true}');
} else process.exit(3);
`);
  }
  const messages = [];
  return {
    root, calls, messages,
    options: {
      stateDir, workspaceDir, node: process.execPath, entry, bridgeEntry,
      gatewayPort: await freePort(),
      env: { ...process.env, OPENCLAW_MIGRATION: MIGRATION_ID, FIXTURE_CALLS: calls },
      log: (message) => messages.push(message),
    },
  };
}

test("migration is disabled without the explicit opt-in", async () => {
  assert.deepEqual(await migrateState({ env: {} }), { status: "disabled" });
  await assert.rejects(migrateState({ env: { OPENCLAW_MIGRATION: "true" } }), /Unsupported/);
});

test("backups retain complete cold state and workspace before ordered bridge/current repair", async (t) => {
  const { options, root, calls, messages } = await fixture(t);
  const result = await migrateState(options);
  assert.equal(result.status, "complete");
  const restore = path.join(root, "restored");
  await fs.mkdir(restore);
  await extract({ file: result.archive, cwd: restore, strict: true });
  assert.equal(await fs.readFile(path.join(restore, ".openclaw", "openclaw.json"), "utf8"), "{\"original\":true}\n");
  assert.deepEqual(await fs.readFile(path.join(restore, ".openclaw", "agents", "main", "state.sqlite")), Buffer.from([0, 1, 2, 255]));
  assert.equal(await fs.readFile(path.join(restore, ".openclaw", "agents", "main", "state.sqlite-wal"), "utf8"), "wal retained");
  assert.equal(await fs.readFile(path.join(restore, ".openclaw", "agents", "main", "state.sqlite-shm"), "utf8"), "shm retained");
  assert.equal(await fs.readFile(path.join(restore, "workspace", "MEMORY.md"), "utf8"), "Fixture memory survives.\n");
  const events = (await fs.readFile(calls, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map(({ stage, args }) => `${stage}:${args[0]}`), ["bridge:--version", "current:--version", "bridge:doctor", "bridge:config", "current:doctor", "current:config"]);
  assert.deepEqual(events[2].args, ["doctor", "--fix", "--non-interactive", "--no-workspace-suggestions"]);
  assert.equal(messages.join("\n").includes("private-fixture-output"), false);
  assert.match(await fs.readFile(path.join(path.dirname(result.archive), "migration.log"), "utf8"), /private-fixture-output/);
  if (process.platform !== "win32") assert.equal((await fs.stat(result.archive)).mode & 0o777, 0o600);
  assert.equal((await migrateState(options)).status, "already-complete");
  assert.equal((await fs.readFile(calls, "utf8")).trim().split("\n").length, events.length);
  await fs.unlink(path.join(options.stateDir, `.railway-migration-${MIGRATION_ID}.json`));
  await assert.rejects(migrateState(options), /automatic retry is disabled/);
  assert.equal((await fs.readFile(calls, "utf8")).trim().split("\n").length, events.length);
});

test("failed current repair retains backup and blocks replay of the older bridge", async (t) => {
  const { options, calls, root } = await fixture(t);
  options.env.FIXTURE_FAIL_STAGE = "current";
  await assert.rejects(migrateState(options), /Migration CLI failed/);
  const runDir = path.join(root, "backups", `openclaw-${MIGRATION_ID}`);
  assert.equal(JSON.parse(await fs.readFile(path.join(runDir, "journal.json"), "utf8")).stage, "current-started");
  assert.ok((await fs.stat(path.join(runDir, "before-migration.tar.gz"))).size > 0);
  const before = await fs.readFile(calls, "utf8");
  delete options.env.FIXTURE_FAIL_STAGE;
  await assert.rejects(migrateState(options), /automatic retry is disabled/);
  assert.equal(await fs.readFile(calls, "utf8"), before);
});

test("failed validation cannot publish completion", async (t) => {
  const { options, root, calls } = await fixture(t);
  options.env.FIXTURE_FAIL_VALIDATE = "bridge";
  await assert.rejects(migrateState(options), /Migration CLI failed/);
  const journal = JSON.parse(await fs.readFile(path.join(root, "backups", `openclaw-${MIGRATION_ID}`, "journal.json"), "utf8"));
  assert.equal(journal.stage, "bridge-started");
  const events = (await fs.readFile(calls, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(events.some((event) => event.stage === "current" && event.args[0] === "doctor"), false);
});

test("wrong CLI version refuses before mutation or backup publication", async (t) => {
  const { options, calls, root } = await fixture(t);
  options.env.FIXTURE_BAD_VERSION = "2026.10.8";
  await assert.rejects(migrateState(options), /version does not match/);
  assert.equal(await fs.readFile(path.join(options.stateDir, "openclaw.json"), "utf8"), "{\"original\":true}\n");
  assert.equal((await fs.readFile(calls, "utf8")).trim().split("\n").length, 1);
  await assert.rejects(fs.stat(path.join(root, "backups", `openclaw-${MIGRATION_ID}`, "journal.json")), { code: "ENOENT" });
});

test("a live gateway prevents backup and both Doctor invocations", async (t) => {
  const { options, calls } = await fixture(t);
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  options.gatewayPort = server.address().port;
  await assert.rejects(migrateState(options), /gateway port is occupied/);
  await assert.rejects(fs.stat(calls), { code: "ENOENT" });
});
