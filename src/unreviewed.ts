import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Pooled, Thresholds } from "./github.ts";
import { ensurePrivateDir, runtimeDir } from "./paths.ts";

export type Pool = { at: number; complete: boolean; prs: Pooled[] };

const staleMs = 10 * 60_000;

export function poolFile(): string {
  return join(runtimeDir(), "unreviewed.json");
}

export function savePool(pool: Pool, file = poolFile()): void {
  ensurePrivateDir(join(file, ".."));
  const temporary = `${file}.${process.pid}`;
  writeFileSync(temporary, JSON.stringify(pool), { mode: 0o600 });
  renameSync(temporary, file);
}

export function readPool(file = poolFile()): Pool | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const pool = JSON.parse(readFileSync(file, "utf8")) as Pool;
    return typeof pool?.at === "number" && Array.isArray(pool.prs) ? pool : undefined;
  } catch {
    return undefined;
  }
}

export const unreviewedColors = { green: "ok", yellow: "#ffc45e", orange: "warning", red: "error" } as const;

export function unreviewedColor(count: number, thresholds: Thresholds): string {
  if (count >= thresholds.red) return unreviewedColors.red;
  if (count >= thresholds.orange) return unreviewedColors.orange;
  if (count >= thresholds.yellow) return unreviewedColors.yellow;
  return unreviewedColors.green;
}

export function unreviewedLine(pool: Pool | undefined, thresholds: Thresholds, now: number): { text: string; color: string } {
  if (!pool) return { text: "● ? to review", color: "muted" };
  const count = `${pool.prs.length}${pool.complete ? "" : "+"}`;
  if (now - pool.at > staleMs) return { text: `● ${count} to review ?`, color: "muted" };
  return { text: `● ${count} to review`, color: unreviewedColor(pool.prs.length, thresholds) };
}
