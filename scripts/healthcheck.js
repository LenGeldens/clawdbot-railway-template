// Use the same public listener and readiness endpoint as Railway.
const port = process.env.PORT ?? process.env.OPENCLAW_PUBLIC_PORT ?? "3000";
try {
  const response = await fetch(`http://127.0.0.1:${port}/setup/healthz`, {
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok || (await response.json()).ok !== true) process.exit(1);
} catch {
  process.exit(1);
}
