import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, parseSince } from "./mcp.ts";
import { handle } from "./server.ts";
import { harness } from "./test-harness.ts";

async function setup() {
  const { core, hear } = harness();
  await hear({ type: "snapshot", tabs: [{ id: 1, number: 1, name: "widgets", dir: "/w/stories/sc-7" }], agents: [{ paneId: 2, tabId: 1, state: "done" }], jobs: [] });
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
  test("agents report waits and status on their braid, and ask what needs the user", async () => {
    const { core, call } = await setup();
    expect(await call("report", { strand: "PR #821 review", whose: "machine", who: "Copilot", reason: "waiting on Copilot review of PR #821" })).toBe("Recorded on report:sc-7:pr-#821-review.");
    expect(await call("status", { text: "step 3 of 10: the command tab", page: "ponpoko/build-status.md" })).toBe("Status set on pane:s1:2.");
    expect(core.model.strands.get("pane:s1:2")!.doing).toMatchObject({ text: "step 3 of 10: the command tab", page: "ponpoko/build-status.md" });
    expect(await call("moves")).toContain("SC-7  Widget CSV import: agent pane 2, turn ended");
    const braid = await call("braid");
    expect(braid).toContain("PR #821 review: waiting on Copilot");
    expect(braid).toContain("now: step 3 of 10");
    expect(await call("changes", { since: "1970-01-01T00:00:00Z" })).toContain("agent: SC-7 PR #821 review waiting on Copilot");
    expect(await call("report", { strand: "PR #821 review", whose: "done", reason: "review in" })).toContain("Recorded");
    expect(core.model.strands.has("report:sc-7:pr-#821-review")).toBe(false);
  });

  test("errors come back as tool errors", async () => {
    const { call } = await setup();
    expect(await call("status", { text: "x", strand: "nothing" })).toContain("no strand nothing");
  });

  test("reads spans and times", () => {
    expect(parseSince("90m", 10_000_000)).toBe(10_000_000 - 90 * 60_000);
    expect(parseSince("2026-11-06T00:00:00Z", 0)).toBe(Date.parse("2026-11-06T00:00:00Z"));
    expect(parseSince("soon", 0)).toBeUndefined();
  });
});
