#!/usr/bin/env bun
import { Down, state } from "./client.ts";
import { age, braidTitle, cause, holder, rows } from "./render.ts";
import { serve } from "./server.ts";

const usage = `Usage:
  ponpoko                 The command tab: every braid, its strands, and what ponpoko heard
  ponpoko list            Your moves, then everything else, printed once
  ponpoko tray            One line for komux's tray
  ponpoko deal [--unseen] Deal your oldest move as a card, for a komux popup
  ponpoko serve           Run the service (ponpoko.service runs this)
  ponpoko setup [--yes]   Install the service, komux plugin, skill and MCP
  ponpoko mcp             The MCP server Claude Code talks to
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
    case "list":
      return list();
    case "deal":
      return (await import("./deal.ts")).runDeal(args.slice(1));
    case "mcp":
      await (await import("./mcp.ts")).runMcp();
      return -1;
    case "setup":
      return (await import("./setup.ts")).setupCommand(args.slice(1));
    case "tray":
      return tray();
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
      for (const strand of snapshot.moves) {
        const braid = snapshot.braids.find((candidate) => candidate.id === strand.braid);
        console.log(`   ● ${age(snapshot.now - strand.since).padStart(6)}  ${braid ? braidTitle(braid) : strand.braid} · ${strand.label} · ${holder(strand, snapshot.now)} · ${cause(strand)}`);
      }
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

async function tray(): Promise<number> {
  try {
    const snapshot = await state();
    const { yours, oldest } = snapshot.counts;
    console.log(yours === 0 ? "○ 0 yours" : `● ${yours} yours ${age(snapshot.now - oldest!)}`);
  } catch {
    console.log("ponpoko ✗");
  }
  return 0;
}

const code = await main(Bun.argv.slice(2));
if (code >= 0) process.exit(code);
