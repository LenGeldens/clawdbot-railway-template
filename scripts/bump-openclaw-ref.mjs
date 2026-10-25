import assert from "node:assert/strict";
import fs from "node:fs";

const dockerPath = "Dockerfile";
const docker = fs.readFileSync(dockerPath, "utf8");
const refLine = /^ARG OPENCLAW_GIT_REF=(v\d+\.\d+\.\d+)$/m;
const shaLine = /^ARG OPENCLAW_GIT_SHA=([a-f0-9]{40})$/m;
const currentRef = docker.match(refLine)?.[1];
const currentSha = docker.match(shaLine)?.[1];
assert.ok(currentRef && currentSha, "Expected both a release tag and immutable commit pin");
const checkOnly = process.argv.includes("--check");

async function github(path) {
  const response = await fetch(`https://api.github.com/repos/openclaw/openclaw${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "clawdbot-railway-template-bot",
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub API: HTTP ${response.status}`);
  return response.json();
}
let ref = currentRef;
if (!checkOnly) {
  const release = await github("/releases/latest");
  assert.equal(release.draft, false);
  assert.equal(release.prerelease, false);
  assert.match(release.tag_name, /^v\d+\.\d+\.\d+$/);
  ref = release.tag_name;
}
// The commits endpoint dereferences annotated tags to the commit used by git.
const { sha } = await github(`/commits/${encodeURIComponent(ref)}`);
assert.match(sha, /^[a-f0-9]{40}$/);
if (checkOnly) {
  assert.equal(sha, currentSha, "Release tag moved: review upstream before changing the pin");
  console.log(`Verified official ${ref} at ${sha}; Dockerfile unchanged.`);
} else if (ref === currentRef && sha === currentSha) {
  console.log("OpenClaw source pins are already current.");
} else {
  fs.writeFileSync(dockerPath, docker
    .replace(refLine, `ARG OPENCLAW_GIT_REF=${ref}`)
    .replace(shaLine, `ARG OPENCLAW_GIT_SHA=${sha}`));
  console.log(`Pinned ${ref} at ${sha}. Review Node/Bun requirements and pass the Docker build/smoke before merging.`);
}
