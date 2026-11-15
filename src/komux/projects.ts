import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

export type Project = { name: string; dir: string };

const keptMs = 60_000;
let cached: { roots: string; at: number; projects: Project[] } | undefined;

export function komuxProjects(env: Record<string, string | undefined> = process.env, now = Date.now()): Project[] {
  const roots = projectRoots(env);
  const key = roots.join("\n");
  if (cached?.roots === key && now - cached.at < keptMs) return cached.projects;
  const projects = findProjects(roots);
  cached = { roots: key, at: now, projects };
  return projects;
}

export function projectRoots(env: Record<string, string | undefined>): string[] {
  const given = env.PONPOKO_PROJECT_ROOTS;
  if (given !== undefined) return given.split(":").filter((root) => root.trim() !== "");
  const path = env.KOMUX_CONFIG || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "komux", "config.ts");
  try {
    const roots = (require(path) as { default?: { projects?: { roots?: unknown } } }).default?.projects?.roots;
    if (Array.isArray(roots) && roots.every((root) => typeof root === "string")) return roots;
  } catch {}
  return ["~/work/*/*"];
}

export function findProjects(roots: string[]): Project[] {
  const projects = new Map<string, Project>();
  for (const root of roots) {
    const pattern = root === "~" ? homedir() : root.startsWith("~/") ? join(homedir(), root.slice(2)) : root;
    if (!isAbsolute(pattern)) continue;
    try {
      for (const match of new Bun.Glob(pattern.replace(/^\//, "")).scanSync({ cwd: "/", onlyFiles: false, absolute: true })) {
        if (isDirectory(match) && !projects.has(match)) projects.set(match, { name: basename(match), dir: match });
      }
    } catch {}
  }
  return [...projects.values()];
}

export function projectNamed(name: string, projects: Project[]): Project | undefined {
  const wanted = name.toLowerCase();
  const found = projects.filter((project) => project.name.toLowerCase() === wanted);
  return found.length === 1 ? found[0] : undefined;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
