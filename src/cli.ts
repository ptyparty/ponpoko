#!/usr/bin/env bun
import { Down, state, watch } from "./client.ts";
import { age, cause, pathText, rows } from "./render.ts";
import { serve } from "./server.ts";

const usage = `Usage:
  ponpoko                 The command tab: every strand and whose move it is
  ponpoko log             What ponpoko heard, newest first, for a komux popup
  ponpoko list            Your moves, then everything else, printed once
  ponpoko tray [--stream] One line for komux's tray; --stream prints a new one as it changes
  ponpoko deal [--unseen] Deal your oldest move as a card, for a komux popup
  ponpoko serve           Run the service (ponpoko.service runs this)
  ponpoko setup [--yes]   Install the service, komux plugin, skill and MCP
  ponpoko mcp             The MCP server Claude Code talks to
  ponpoko komux           The komux bridge, run by the komux plugin in each session
`;

async function main(args: string[]): Promise<number> {
  const [command] = args;
  switch (command) {
    case "serve":
      await serve();
      return -1;
    case undefined:
    case "tab":
      return (await import("./tab.ts")).runTab();
    case "log": {
      const [{ runLive }, { LogView }] = await Promise.all([import("./tab.ts"), import("./log.ts")]);
      return runLive(new LogView());
    }
    case "list":
      return list();
    case "deal":
      return (await import("./deal.ts")).runDeal(args.slice(1));
    case "komux":
      return (await import("./komux/bridge.ts")).runBridge();
    case "mcp":
      await (await import("./mcp.ts")).runMcp();
      return -1;
    case "setup":
      return (await import("./setup.ts")).setupCommand(args.slice(1));
    case "tray":
      return tray(args.slice(1));
    case "-h":
    case "--help":
    case "help":
      console.log(usage);
      return 0;
    default:
      console.error(usage);
      return 2;
  }
}

async function list(): Promise<number> {
  try {
    const snapshot = await state();
    const width = process.stdout.columns ?? 100;
    if (snapshot.moves.length > 0) {
      console.log(" Your moves, oldest first\n");
      for (const strand of snapshot.moves) console.log(`   ● ${age(snapshot.now - strand.own.since).padStart(6)}  ${pathText(strand)} · ${cause(strand)}`);
      console.log("");
    }
    for (const row of rows(snapshot, width)) console.log(row.text);
    return 0;
  } catch (error) {
    if (error instanceof Down) {
      console.error(`ponpoko isn't running. Start it with \`systemctl --user start ponpoko\` or \`ponpoko serve\`.`);
      return 1;
    }
    throw error;
  }
}

async function tray(args: string[]): Promise<number> {
  if (!args.includes("--stream")) {
    console.log((await trayLine()).text);
    return 0;
  }
  let last = "";
  const print = async () => {
    const line = JSON.stringify(await trayLine());
    if (line === last) return;
    last = line;
    console.log(line);
  };
  let connection: { close: () => void } | undefined;
  const connect = async () => {
    connection = await watch(
      () => void print(),
      () => {
        connection = undefined;
        void print();
      },
    ).catch(() => undefined);
  };
  await print();
  await connect();
  setInterval(() => {
    if (!connection) void connect();
    void print();
  }, 15_000);
  return -1;
}

export async function trayLine(): Promise<{ text: string; color: string }> {
  try {
    const snapshot = await state();
    const { yours, oldest } = snapshot.counts;
    if (yours === 0) return { text: "○ 0 yours", color: "muted" };
    return { text: `● ${yours} yours ${age(snapshot.now - oldest!)}`, color: "warning" };
  } catch {
    return { text: "ponpoko ✗", color: "muted" };
  }
}

const code = await main(Bun.argv.slice(2));
if (code >= 0) process.exit(code);
