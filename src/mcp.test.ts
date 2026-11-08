import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, parseSince, strandText } from "./mcp.ts";
import { handle } from "./server.ts";
import { harness } from "./test-harness.ts";

async function setup() {
  const { core, hear } = harness();
  await hear({ type: "snapshot", tabs: [{ id: 1, number: 1, name: "widgets", dir: "/w/stories/sc-7", labels: { strand: "sc-7" } }], agents: [{ paneId: 2, tabId: 1, state: "working" }], jobs: [] });
  const send = async (request: Parameters<typeof handle>[1]) => {
    const response = await handle(core, request);
    if (!response.ok) throw new Error(response.error);
    return response.result;
  };
  const server = createServer({ self: "komux:s1:2", dir: "/w/stories/sc-7" }, send, async () => core.snapshot());
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return (result.content as { text: string }[])[0]!.text;
  };
  return { core, call };
}

describe("the ponpoko MCP", () => {
  test("agents can title the strands status and split make", async () => {
    const { core, call } = await setup();
    await call("status", { text: "starting", strand: "titles", title: "Let agents title strands" });
    await call("split", { names: [{ name: "status", title: "Title from status" }, "split"] });
    const titles = Object.fromEntries(core.snapshot().strands.map((entry) => [entry.name, entry.title]));
    expect(titles).toEqual({ "sc-7": "Widget CSV import", titles: "Let agents title strands", status: "Title from status", split: undefined });
  });

  test("agents say what they're doing on which strand, split it, wait on others, and ask what needs the user", async () => {
    const { core, call } = await setup();
    await call("status", { text: "warming up" });
    expect(await call("split", { strand: "sc-7 › review findings", names: ["1", "2"] })).toBe("Made sc-7 › review findings › 1; sc-7 › review findings › 2.");
    expect(await call("status", { text: "fixing the report id", strand: "review findings › 1", page: "ponpoko/review-findings.md" })).toBe("Now on sc-7 › review findings › 1.");
    expect(await call("wait", { who: "Copilot", kind: "machine", what: "reviewing PR #821", strand: "review findings › 2" })).toBe("Waiting on sc-7 › review findings › 2.");
    expect(await call("moves")).toBe("Nothing is waiting on the user.");
    const strand = await call("strand", { strand: "review findings" });
    expect(strand).toContain("- 1: claude working, reported: fixing the report id");
    expect(strand).toContain("- 2: waiting on Copilot, reported: reviewing PR #821");
    expect(await call("strand")).toContain("sc-7 › review findings › 1");
    expect(await call("changes", { since: "1970-01-01T00:00:00Z" })).toContain("agent: sc-7 › review findings › 2 → Copilot: reviewing PR #821");
    expect(await call("wait", { who: "Copilot", kind: "machine", what: "review in", over: true, strand: "review findings › 2" })).toContain("Wait over");
    expect(await call("moves")).toMatch(/^1 strand waiting on the user, oldest first:\n- sc-7 › review findings › 2: no one on it, now$/);
    expect(await call("done", { strand: "review findings › 2" })).toBe("sc-7 › review findings › 2 is done.");
    expect(core.snapshot().strands.map((entry) => entry.name)).toEqual(["sc-7", "review findings", "1"]);
  });

  test("outside komux, the strand tool finds the strand by directory, not by an unrelated wait", async () => {
    const { core } = await setup();
    core.wait({ strand: "elsewhere", who: "Copilot", kind: "machine", what: "review" });
    core.point("/w/stories/sc-7", "sc-7");
    expect(strandText(core.snapshot(), undefined, { dir: "/w/stories/sc-7/app" }).split("\n")[0]).toBe("sc-7  Widget CSV import");
  });

  test("errors come back as tool errors", async () => {
    const { call } = await setup();
    expect(await call("done", { strand: "nothing" })).toContain("no strand nothing");
  });

  test("reads spans and times", () => {
    expect(parseSince("90m", 10_000_000)).toBe(10_000_000 - 90 * 60_000);
    expect(parseSince("2026-11-06T00:00:00Z", 0)).toBe(Date.parse("2026-11-06T00:00:00Z"));
    expect(parseSince("soon", 0)).toBeUndefined();
  });
});
