/** Finalization never skips teardown because evidence collection or database shutdown failed. */
export type Resources = { containers: string[]; volumes: string[]; networks: string[] };
export type CleanupResult = { ok: boolean; errors: string[]; downExit: number | null; remaining: Resources | null };
type Steps = {
  evidence(): Promise<void>;
  observers(): Promise<void>;
  down(): Promise<{ exit: number | null }>;
  inventory(): Promise<Resources>;
  record(result: CleanupResult): void;
};
export async function cleanup(steps: Steps, limits: Partial<Record<"evidence" | "observers" | "down" | "inventory", number>> = {}): Promise<CleanupResult> {
  const result: CleanupResult = { ok: false, errors: [], downExit: null, remaining: null };
  async function attempt<T>(name: keyof typeof limits, task: () => Promise<T>, fallbackMs: number): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(task), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} deadline exceeded`)), limits[name] ?? fallbackMs);
      })]);
    } catch (error) { result.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
    finally { clearTimeout(timer); }
  }
  await attempt("evidence", steps.evidence, 100_000);
  await attempt("observers", steps.observers, 5000);
  const down = await attempt("down", steps.down, 310_000);
  result.downExit = down?.exit ?? null;
  if (down && down.exit !== 0) result.errors.push(`down: exit ${String(down.exit)}`);
  const remaining = await attempt("inventory", steps.inventory, 100_000);
  if (remaining) {
    result.remaining = remaining;
    for (const [kind, ids] of Object.entries(remaining)) if (ids.length) result.errors.push(`inventory: remaining ${kind}: ${ids.join(", ")}`);
  }
  result.ok = result.errors.length === 0 && result.downExit === 0 && result.remaining !== null;
  try { steps.record(result); } catch (error) { result.ok = false; result.errors.push(`record: ${error instanceof Error ? error.message : String(error)}`); }
  return result;
}
