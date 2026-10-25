import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// Run inside the built image, using an empty test volume. No login, provider
// request or channel connection is attempted by this installation check.
function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, `${command}: ${result.error?.message}`);
  assert.equal(result.status, 0, `${command} ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

const entry = process.env.OPENCLAW_ENTRY || "/openclaw/openclaw.mjs";
const root = path.dirname(fs.realpathSync(entry));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = run("openclaw", ["--version"]);
assert.equal(run(process.env.OPENCLAW_NODE || "node", [entry, "--version"]), version);
assert.ok(version.includes(pkg.version), `CLI ${version} disagrees with package ${pkg.version}`);
assert.ok(fs.statSync(path.join(root, "dist/control-ui/index.html")).size > 0);

function pluginRoot(id) {
  // Source manifests retain plugin-local dependency resolution, while runtime
  // builds may also ship their metadata under dist/extensions/<id>.
  return [path.join(root, "extensions", id), path.join(root, "dist/extensions", id)]
    .find(candidate => fs.existsSync(path.join(candidate, "openclaw.plugin.json")));
}
for (const id of ["codex", "whatsapp"]) {
  assert.ok(pluginRoot(id), `Missing plugin ${id}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot(id), "openclaw.plugin.json"), "utf8"));
  assert.equal(manifest.id, id);
}
assert.ok(fs.statSync(path.join(root, "dist/extensions/whatsapp/index.js")).size > 0, "Missing compiled external WhatsApp runtime");
const codexRoot = pluginRoot("codex");
const codexPlugin = JSON.parse(fs.readFileSync(path.join(codexRoot, "package.json"), "utf8"));
const requireCodex = createRequire(path.join(codexRoot, "package.json"));
const codexPackagePath = requireCodex.resolve("@openai/codex/package.json");
const codexPackage = JSON.parse(fs.readFileSync(codexPackagePath, "utf8"));
assert.equal(codexPackage.version, codexPlugin.dependencies["@openai/codex"]);
const codexBin = typeof codexPackage.bin === "string" ? codexPackage.bin : codexPackage.bin.codex;
const codexVersion = run("node", [path.resolve(path.dirname(codexPackagePath), codexBin), "--version"]);
assert.ok(codexVersion.includes(codexPackage.version));

console.log(`OpenClaw CLI and wrapper entry: ${version}`);
console.log(`Control UI, WhatsApp and Codex manifests present; native Codex starts: ${codexVersion}`);
const bridgeEntry = "/opt/openclaw-bridge/node_modules/openclaw/openclaw.mjs";
const bridgePackage = JSON.parse(fs.readFileSync(path.join(path.dirname(bridgeEntry), "package.json"), "utf8"));
assert.equal(bridgePackage.version, "2026.9.5");
const bridgeVersion = run("node", [bridgeEntry, "--version"]);
assert.ok(bridgeVersion.includes(bridgePackage.version));
console.log(`Isolated legacy migration bridge starts: ${bridgeVersion}`);
