import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ponpoko } from "./core.ts";
import { moveToRequests, Store } from "./store.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function storeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ponpoko-store-"));
  dirs.push(dir);
  return dir;
}

describe("moving the store to requests", () => {
  test("keeps the strands and what's known about them, drops open moves and GitHub's memory of states, and keeps the old file beside it", () => {
    const dir = storeDir();
    const old = new Store(join(dir, "facts.sqlite"));
    old.append("you", { type: "strand.made", strand: "s1", name: "sc-1" }, 10);
    old.append("shortcut", { type: "strand.titled", strand: "s1", kind: "story", title: "Widgets" }, 11);
    old.append("komux", { type: "player.joined", player: "pane:s1:2", kind: "agent", who: "claude" }, 12);
    old.append("komux", { type: "move.opened", move: "m1", strand: "s1", player: "you", with: "pane:s1:2", what: "ready for a prompt" }, 13);
    old.append("agent", { type: "link.added", link: "l1", move: "m1", adapter: "quoll", ref: "sc-1/plan.md" }, 14);
    old.append("agent", { type: "link.removed", link: "l1" }, 15);
    old.append("github", { type: "link.added", link: "l2", strand: "s1", adapter: "github", ref: "https://github.com/acme/widgets/pull/9" }, 16);
    old.append("github", { type: "link.added", link: "l3", strand: "s1", adapter: "github-pr-state", ref: "{}" }, 17);
    old.append("you", { type: "strand.note", strand: "s1", text: "ask Sam" }, 18);
    old.close();

    expect(moveToRequests(dir)).toBe(true);
    expect(moveToRequests(dir)).toBe(false);
    expect(existsSync(join(dir, "facts-moving.sqlite"))).toBe(false);

    const kept = new Store(join(dir, "events-v2.sqlite"));
    expect(kept.all()).toHaveLength(9);
    kept.close();
    const moved = new Store(join(dir, "facts.sqlite"));
    expect(moved.all().map((event) => [event.type, event.at, event.source])).toEqual([
      ["strand.made", 10, "you"],
      ["strand.titled", 11, "shortcut"],
      ["player.joined", 12, "komux"],
      ["link.added", 16, "github"],
      ["strand.note", 18, "you"],
    ]);
    const strand = new Ponpoko(moved).snapshot().strands[0]!;
    expect([strand.title, strand.open, strand.links.map((link) => link.adapter), strand.notes.map((note) => note.text)]).toEqual(["Widgets", [], ["github"], ["ask Sam"]]);
    moved.close();
  });

  test("a move cut short between swapping the files finishes on the next start", () => {
    const dir = storeDir();
    const old = new Store(join(dir, "facts.sqlite"));
    old.append("you", { type: "strand.made", strand: "s1", name: "sc-1" }, 10);
    old.close();
    expect(moveToRequests(dir)).toBe(true);
    renameSync(join(dir, "facts.sqlite"), join(dir, "facts-moving.sqlite"));
    expect(moveToRequests(dir)).toBe(false);
    const moved = new Store(join(dir, "facts.sqlite"));
    expect(moved.all()).toHaveLength(1);
    moved.close();
  });

  test("a fresh store counts as moved, so its own facts are never dropped later", () => {
    const dir = storeDir();
    expect(moveToRequests(dir)).toBe(false);
    const fresh = new Store(join(dir, "facts.sqlite"));
    fresh.append("github", { type: "link.added", link: "l1", strand: "s1", adapter: "github-state", ref: "k" }, 10);
    fresh.close();
    expect(moveToRequests(dir)).toBe(false);
  });

  test("facts this ponpoko can't read are carried over as they are", () => {
    const dir = storeDir();
    new Store(join(dir, "facts.sqlite")).close();
    const db = new Database(join(dir, "facts.sqlite"));
    db.run("insert into events (at, source, type, body) values (10, 'future', 'strand.glowed', '{\"type\":\"strand.glowed\"}')");
    db.close();
    expect(moveToRequests(dir)).toBe(true);
    const moved = new Store(join(dir, "facts.sqlite"));
    expect(moved.rows().map((row) => row.type)).toEqual(["strand.glowed"]);
    moved.close();
  });

  test("a move cut short is done again from the top", () => {
    const dir = storeDir();
    const old = new Store(join(dir, "facts.sqlite"));
    old.append("you", { type: "strand.made", strand: "s1", name: "sc-1" }, 10);
    old.close();
    const leftover = new Store(join(dir, "facts-moving.sqlite"));
    leftover.append("you", { type: "strand.made", strand: "s9", name: "half done" }, 5);
    leftover.close();
    expect(moveToRequests(dir)).toBe(true);
    const moved = new Store(join(dir, "facts.sqlite"));
    expect(moved.all().map((event) => (event.type === "strand.made" ? event.name : event.type))).toEqual(["sc-1"]);
    moved.close();
  });
});
