import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export function stateDir(): string {
  if (process.env.PONPOKO_STATE_DIR) return process.env.PONPOKO_STATE_DIR;
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "ponpoko");
}

export function runtimeDir(): string {
  if (process.env.PONPOKO_RUNTIME_DIR) return process.env.PONPOKO_RUNTIME_DIR;
  return join(process.env.XDG_RUNTIME_DIR ?? join(tmpdir(), `ponpoko-${process.getuid?.() ?? "user"}`), "ponpoko");
}

export function socketPath(): string {
  return join(runtimeDir(), "ponpoko.sock");
}

export function ensurePrivateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}
