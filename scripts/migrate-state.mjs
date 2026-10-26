import fs from "node:fs/promises";
import { createReadStream, openSync, closeSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { create, list } from "tar";

export const MIGRATION_ID = "2026.10.7-from-prejuly";
const TARGET_VERSION = "2026.10.7";
const BRIDGE_VERSION = "2026.9.5";

async function exists(file) {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function assertGatewayStopped(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid migration gateway port.");
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); reject(new Error("Migration refused: gateway port is occupied. Stop its owner first.")); });
    socket.once("error", (error) => error.code === "ECONNREFUSED" ? resolve() : reject(new Error("Cannot verify that the gateway is stopped.", { cause: error })));
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error("Gateway stop check timed out.")); });
  });
}

// Keep command output in a private file. Never put a Doctor diagnostic or auth
// value into Railway logs or a thrown error.
async function runCli(node, entry, args, env, logFile, capture = false) {
  const fd = openSync(logFile, "a", 0o600);
  try {
    return await new Promise((resolve, reject) => {
      let output = "";
      let settled = false;
      let timeoutError;
      let killTimer;
      const child = spawn(node, [entry, ...args], {
        env, windowsHide: true, stdio: ["ignore", capture ? "pipe" : fd, fd],
      });
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        error ? reject(error) : resolve(output);
      };
      const terminate = (error) => {
        timeoutError = error;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      };
      const timer = setTimeout(() => {
        // Do not let a timed-out migration proceed into the next stage.
        terminate(new Error("Migration CLI timed out; inspect the private log before recovery."));
      }, 10 * 60_000);
      child.stdout?.on("data", (chunk) => {
        output += chunk.toString();
        if (output.length > 64_000 && !timeoutError) terminate(new Error("Unexpected version output; migration refused."));
      });
      child.once("error", () => finish(new Error("Could not start migration CLI; inspect the installation.")));
      child.once("exit", (code, signal) => finish(timeoutError ?? (code === 0 ? undefined : new Error(`Migration CLI failed (exit ${code ?? "none"}, signal ${signal ?? "none"}); inspect the private log.`))));
    });
  } finally { closeSync(fd); }
}

async function writeJournal(file, value) {
  const pending = `${file}.tmp`;
  await fs.writeFile(pending, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(pending, 0o600);
  await fs.rename(pending, file);
}

/** Explicit, offline upgrade only. Ordinary deployments never run Doctor here. */
export async function migrateState({
  stateDir,
  workspaceDir,
  entry = "/openclaw/openclaw.mjs",
  node = "node",
  gatewayPort = 18789,
  env = process.env,
  bridgeEntry = "/opt/openclaw-bridge/node_modules/openclaw/openclaw.mjs",
  backupRoot,
  log = console.log,
} = {}) {
  if (!env.OPENCLAW_MIGRATION) return { status: "disabled" };
  if (env.OPENCLAW_MIGRATION !== MIGRATION_ID) throw new Error("Unsupported OPENCLAW_MIGRATION value; migration refused.");
  stateDir = path.resolve(stateDir ?? env.OPENCLAW_STATE_DIR ?? "/data/.openclaw");
  workspaceDir = path.resolve(workspaceDir ?? env.OPENCLAW_WORKSPACE_DIR ?? "/data/workspace");
  const dataRoot = path.dirname(stateDir);
  if (path.dirname(workspaceDir) !== dataRoot || stateDir === workspaceDir) {
    throw new Error("Migration requires separate state and workspace directories under the same volume root; use manual maintenance for custom layouts.");
  }
  backupRoot = path.resolve(backupRoot ?? path.join(dataRoot, "backups"));
  if (inside(stateDir, backupRoot) || inside(workspaceDir, backupRoot)) throw new Error("Backup directory must be outside state and workspace.");
  const runDir = path.join(backupRoot, `openclaw-${MIGRATION_ID}`);
  const journalFile = path.join(runDir, "journal.json");
  const stateReceiptFile = path.join(stateDir, `.railway-migration-${MIGRATION_ID}.json`);
  const archive = path.join(runDir, "before-migration.tar.gz");
  const logFile = path.join(runDir, "migration.log");
  for (const directory of [stateDir, workspaceDir]) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Migration source must be a real directory.");
  }
  if (await exists(journalFile)) {
    const previous = JSON.parse(await fs.readFile(journalFile, "utf8"));
    const receipt = await exists(stateReceiptFile) ? JSON.parse(await fs.readFile(stateReceiptFile, "utf8")) : undefined;
    if (previous.id === MIGRATION_ID && previous.stage === "complete" && previous.stateDir === stateDir && previous.workspaceDir === workspaceDir && receipt?.runId === previous.runId && receipt?.targetVersion === TARGET_VERSION && previous.archiveSha256 === await sha256(archive)) {
      log("[migration] completed migration already recorded; skipping Doctor");
      return { status: "already-complete", archive };
    }
    throw new Error(`An incomplete or mismatched migration journal exists at ${journalFile}; automatic retry is disabled. Inspect it before manual recovery.`);
  }
  await assertGatewayStopped(gatewayPort);
  await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
  await fs.chmod(runDir, 0o700);
  const lockFile = path.join(runDir, "migration.lock");
  const lock = await fs.open(lockFile, "wx", 0o600).catch(() => { throw new Error("Migration already running or interrupted; inspect the retained lock before recovery."); });
  let journal;
  try {
    if (await exists(journalFile) || await exists(archive)) throw new Error("Retained migration artifacts require manual inspection before retry.");
    const cliEnv = { ...env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_WORKSPACE_DIR: workspaceDir };
    for (const [cliEntry, expected] of [[bridgeEntry, BRIDGE_VERSION], [entry, TARGET_VERSION]]) {
      const version = (await runCli(node, cliEntry, ["--version"], cliEnv, logFile, true)).trim();
      if (!new RegExp(`^(?:OpenClaw\\s+)?${expected.replaceAll(".", "\\.")}(?:\\s+\\([^\\r\\n]*\\))?$`, "i").test(version)) {
        throw new Error(`Migration CLI version does not match required ${expected}.`);
      }
    }
    // The caller has not started any OpenClaw process. Preserve the entire cold
    // directory, including SQLite WAL/SHM files and all credentials/history.
    log("[migration] creating private full state and workspace backup");
    await create({ cwd: dataRoot, file: archive, gzip: true, strict: true, follow: false, mode: 0o600 }, [path.basename(stateDir), path.basename(workspaceDir)]);
    await fs.chmod(archive, 0o600);
    let entries = 0;
    await list({ file: archive, strict: true, onReadEntry: () => { entries += 1; } });
    if (entries < 2 || (await fs.stat(archive)).size === 0) throw new Error("Migration backup verification failed.");
    journal = { id: MIGRATION_ID, runId: randomUUID(), stage: "backed-up", stateDir, workspaceDir, archive, archiveSha256: await sha256(archive), archiveEntries: entries, createdAt: new Date().toISOString() };
    await writeJournal(journalFile, journal);
    for (const [stage, cliEntry] of [["bridge", bridgeEntry], ["current", entry]]) {
      await assertGatewayStopped(gatewayPort);
      journal = { ...journal, stage: `${stage}-started`, updatedAt: new Date().toISOString() };
      await writeJournal(journalFile, journal);
      log(`[migration] running ${stage} Doctor; details remain in the private log`);
      await runCli(node, cliEntry, ["doctor", "--fix", "--non-interactive", "--no-workspace-suggestions"], cliEnv, logFile);
      await runCli(node, cliEntry, ["config", "validate", "--json"], cliEnv, logFile);
      journal = { ...journal, stage: `${stage}-complete`, updatedAt: new Date().toISOString() };
      await writeJournal(journalFile, journal);
    }
    // A restore of the pre-upgrade state removes this receipt. A completed
    // journal outside /data/.openclaw must not silently admit that older state.
    await writeJournal(stateReceiptFile, { id: MIGRATION_ID, runId: journal.runId, targetVersion: TARGET_VERSION });
    journal = { ...journal, stage: "complete", completedAt: new Date().toISOString() };
    await writeJournal(journalFile, journal);
    log("[migration] Doctor and config validation completed; gateway and model checks remain required");
    return { status: "complete", archive };
  } finally {
    await lock.close();
    await fs.unlink(lockFile);
  }
}
