import { Database } from "bun:sqlite";
import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fact, type Fact, type Recorded, type Source } from "./events.ts";
import { ownStateAdapter, stateAdapter } from "./inbox.ts";
import { ensurePrivateDir, stateDir } from "./paths.ts";

type Row = { id: number; at: number; source: Source; body: string };
type RawRow = Row & { type: string };

export class Store {
  private readonly db: Database;

  constructor(path = defaultPath()) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("pragma journal_mode = wal");
    this.db.run("create table if not exists events (id integer primary key, at integer not null, source text not null, type text not null, body text not null)");
    this.db.run("create index if not exists events_at on events (at)");
  }

  append(source: Source, event: Fact, at = Date.now()): Recorded {
    const parsed = fact.parse(event);
    const { id } = this.db.query<{ id: number }, [number, string, string, string]>("insert into events (at, source, type, body) values (?, ?, ?, ?) returning id").get(at, source, parsed.type, JSON.stringify(parsed))!;
    return { ...parsed, id, at, source };
  }

  all(): Recorded[] {
    return this.db.query<Row, []>("select id, at, source, body from events order by id").all().flatMap((row) => this.decode(row));
  }

  since(at: number): Recorded[] {
    return this.db.query<Row, [number]>("select id, at, source, body from events where at > ? order by id").all(at).flatMap((row) => this.decode(row));
  }

  inOne(work: () => void): void {
    this.db.transaction(work)();
  }

  rows(): RawRow[] {
    return this.db.query<RawRow, []>("select id, at, source, type, body from events order by id").all();
  }

  appendRow(row: RawRow): void {
    this.db.query("insert into events (at, source, type, body) values (?, ?, ?, ?)").run(row.at, row.source, row.type, row.body);
  }

  close(): void {
    this.db.close();
  }

  private decode(row: Row): Recorded[] {
    const parsed = fact.safeParse(JSON.parse(row.body));
    return parsed.success ? [{ ...parsed.data, id: row.id, at: row.at, source: row.source }] : [];
  }
}

function defaultPath(): string {
  const dir = ensurePrivateDir(stateDir());
  const path = join(dir, "facts.sqlite");
  const old = join(dir, "events.sqlite");
  if (!existsSync(path) && existsSync(old)) {
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(old + suffix)) renameSync(old + suffix, join(dir, `events-v1.sqlite${suffix}`));
  }
  moveToRequests(dir);
  return path;
}

export function moveToRequests(dir: string): boolean {
  const path = join(dir, "facts.sqlite");
  const kept = join(dir, "events-v2.sqlite");
  const moving = join(dir, "facts-moving.sqlite");
  const files = (from: string, to: string) => {
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(from + suffix)) renameSync(from + suffix, to + suffix);
  };
  if (existsSync(kept)) {
    if (!existsSync(path) && existsSync(moving)) files(moving, path);
    return false;
  }
  if (!existsSync(path)) {
    new Store(kept).close();
    return false;
  }
  for (const suffix of ["", "-wal", "-shm"]) rmSync(moving + suffix, { force: true });
  const dropped = new Set([stateAdapter, ownStateAdapter]);
  const from = new Store(path);
  const to = new Store(moving);
  const links = new Set<string>();
  to.inOne(() => {
    for (const row of from.rows()) {
      if (row.type === "move.opened" || row.type === "move.described" || row.type === "move.closed") continue;
      if (row.type === "link.added" || row.type === "link.removed") {
        const body = JSON.parse(row.body) as { link?: string; move?: string; adapter?: string };
        if (row.type === "link.added" && body.link && (body.move !== undefined || dropped.has(body.adapter ?? ""))) {
          links.add(body.link);
          continue;
        }
        if (row.type === "link.removed" && body.link && links.has(body.link)) continue;
      }
      to.appendRow(row);
    }
  });
  from.close();
  to.close();
  files(path, kept);
  files(moving, path);
  return true;
}
