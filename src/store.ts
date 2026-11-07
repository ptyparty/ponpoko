import { Database } from "bun:sqlite";
import { join } from "node:path";
import { fact, type Fact, type Recorded, type Source } from "./events.ts";
import { ensurePrivateDir, stateDir } from "./paths.ts";

type Row = { id: number; at: number; source: Source; body: string };

export class Store {
  private readonly db: Database;

  constructor(path = join(ensurePrivateDir(stateDir()), "events.sqlite")) {
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

  close(): void {
    this.db.close();
  }

  private decode(row: Row): Recorded[] {
    const parsed = fact.safeParse(JSON.parse(row.body));
    return parsed.success ? [{ ...parsed.data, id: row.id, at: row.at, source: row.source }] : [];
  }
}
