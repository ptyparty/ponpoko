import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Knowledge } from "./core.ts";
import type { Checkouts } from "./inbox.ts";
import { readKomuxTabRef } from "./komux/translate.ts";

export type BranchOf = (dir: string) => Promise<string | undefined>;

export async function gitBranch(dir: string): Promise<string | undefined> {
  try {
    const result = await Bun.$`git -C ${dir} rev-parse --abbrev-ref HEAD`.quiet().nothrow();
    const branch = result.exitCode === 0 ? result.stdout.toString().trim() : "";
    return branch && branch !== "HEAD" ? branch : undefined;
  } catch {
    return undefined;
  }
}

export function strandDirs(knowledge: Knowledge): { strand: string; dir: string }[] {
  const live = new Set(knowledge.strands.map((strand) => strand.id));
  const out = new Map<string, string>();
  for (const link of knowledge.links) {
    if (!link.strand || !live.has(link.strand) || link.strand.startsWith("github:") || link.strand.startsWith("pr:")) continue;
    const dir = link.adapter === "dir" ? link.ref : link.adapter === "komux" ? readKomuxTabRef(link.ref)?.dir : undefined;
    if (dir && !out.has(dir)) out.set(dir, link.strand);
  }
  return [...out].map(([dir, strand]) => ({ strand, dir })).sort((a, b) => a.dir.length - b.dir.length);
}

export function repoDirs(dir: string): string[] {
  if (existsSync(join(dir, ".git"))) return [dir];
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() && existsSync(join(dir, entry.name, ".git")) ? [join(dir, entry.name)] : []));
  } catch {
    return [];
  }
}

export async function checkouts(knowledge: Knowledge, branchOf: BranchOf = gitBranch, reposIn: (dir: string) => string[] = repoDirs): Promise<Checkouts> {
  const repos = new Map<string, string>();
  for (const { strand, dir } of strandDirs(knowledge)) for (const repo of reposIn(dir)) if (!repos.has(repo)) repos.set(repo, strand);
  const branches = await Promise.all([...repos].map(async ([repo, strand]) => ({ strand, branch: await branchOf(repo) })));
  const owners = new Map<string, Set<string>>();
  for (const { strand, branch } of branches) if (branch) owners.set(branch, new Set([...(owners.get(branch) ?? []), strand]));
  return new Map([...owners].flatMap(([branch, strands]) => (strands.size === 1 ? [[branch, [...strands][0]!] as const] : [])));
}
