import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

export type Project = { name: string; dir: string };

const keptMs = 60_000;
type Cached = { at: number; projects: Project[]; loading?: Promise<Project[]> };
const cache = new Map<string, Cached>();

function sourceOf(env: Record<string, string | undefined>): string {
  return env.PONPOKO_PROJECT_ROOTS !== undefined ? `roots:${env.PONPOKO_PROJECT_ROOTS}` : `config:${configPath(env)}`;
}

export function knownProjects(env: Record<string, string | undefined> = process.env, now = Date.now()): Project[] {
  const cached = cache.get(sourceOf(env));
  if (!cached || now - cached.at >= keptMs) void loadProjects(env, now).catch(() => undefined);
  return cached?.projects ?? [];
}

export function loadProjects(env: Record<string, string | undefined> = process.env, now = Date.now()): Promise<Project[]> {
  const key = sourceOf(env);
  const cached = cache.get(key);
  if (cached && now - cached.at < keptMs) return Promise.resolve(cached.projects);
  if (cached?.loading) return cached.loading;
  const loading = projectRoots(env)
    .then(findProjects)
    .then((projects) => {
      cache.set(key, { at: Date.now(), projects });
      return projects;
    })
    .catch((error: unknown) => {
      cache.delete(key);
      throw error;
    });
  cache.set(key, { at: cached?.at ?? 0, projects: cached?.projects ?? [], loading });
  return loading;
}

function configPath(env: Record<string, string | undefined>): string {
  return env.KOMUX_CONFIG || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "komux", "config.ts");
}

export async function projectRoots(env: Record<string, string | undefined>): Promise<string[]> {
  const given = env.PONPOKO_PROJECT_ROOTS;
  if (given !== undefined) return given.split(":").filter((root) => root.trim() !== "");
  const text = await Bun.file(configPath(env))
    .text()
    .catch(() => "");
  return readRoots(text) ?? ["~/work/*/*"];
}

export function readRoots(config: string): string[] | undefined {
  const found = /\bprojects\s*:\s*\{[\s\S]*?\broots\s*:\s*\[([^\]]*)\]/.exec(config);
  if (!found) return undefined;
  return [...found[1]!.matchAll(/(["'`])((?:(?!\1).)+)\1/g)].map((match) => match[2]!);
}

export async function findProjects(roots: string[]): Promise<Project[]> {
  const projects = new Map<string, Project>();
  for (const root of roots) {
    const pattern = root === "~" ? homedir() : root.startsWith("~/") ? join(homedir(), root.slice(2)) : root;
    if (!isAbsolute(pattern)) continue;
    try {
      for await (const match of new Bun.Glob(pattern.replace(/^\//, "")).scan({ cwd: "/", onlyFiles: false, absolute: true })) {
        if (!projects.has(match) && (await isDirectory(match))) projects.set(match, { name: basename(match), dir: match });
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

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
