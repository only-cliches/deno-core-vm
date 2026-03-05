export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(
  fn: () => boolean,
  timeoutMs: number,
  opts?: { intervalMs?: number; label?: string },
): Promise<void> {
  const intervalMs = opts?.intervalMs ?? 10;
  const label = opts?.label ?? "waitFor timeout";
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await sleep(intervalMs);
  }
  throw new Error(label);
}
