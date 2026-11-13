import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { applyLink, linkState, removeLink, type Link } from "./links.ts";

const repoRoot = join(import.meta.dir, "..");
const cli = join(repoRoot, "src", "cli.ts");

const usage = `Usage: ponpoko setup [--yes|--remove]
  Lists what ponpoko installs and whether each piece is in place:
  the ponpoko.service user unit, the komux plugin, the Claude Code skill and the MCP.
  --yes installs what's missing, and --remove takes it all out again.
  It never edits komux's config; it prints the lines to add.`;

export type Places = { home: string; config: string; claude: string; bun: string; cli: string; root: string };

export function defaultPlaces(): Places {
  const home = homedir();
  return {
    home,
    config: process.env.XDG_CONFIG_HOME ?? join(home, ".config"),
    claude: process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
    bun: process.execPath,
    cli,
    root: repoRoot,
  };
}

export type Run = (command: string[]) => { ok: boolean; output: string };

const run: Run = (command) => {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  return { ok: result.exitCode === 0, output: `${result.stdout.toString()}${result.stderr.toString()}`.trim() };
};

export function unitText(places: Places): string {
  return `[Unit]
Description=ponpoko, whose move each piece of work is

[Service]
ExecStart=${places.bun} ${places.cli} serve
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export function pluginText(places: Places): string {
  return `const command = ${JSON.stringify([places.bun, places.cli])};

export type PonpokoOptions = { deal?: string; catchUp?: string; leader?: string };

export default function ponpoko(options: PonpokoOptions = {}) {
  const deal = { popup: [...command, "deal"], name: "your move", width: 95, height: 75 };
  const catchUp = { popup: [...command, "deal", "--unseen"], name: "catch up", width: 95, height: 75 };
  const thisTab = { popup: [...command, "deal", "--tab"], name: "this tab", width: 95, height: 75 };
  return {
    name: "ponpoko",
    run: [[...command, "komux"]],
    tray: [{ name: "ponpoko", stream: [...command, "tray", "--stream"], open: command }],
    keys: [
      { key: options.deal ?? "alt+m", ...deal },
      { key: options.catchUp ?? "alt+shift+m", ...catchUp },
    ],
    modes: [
      {
        key: options.leader ?? "m",
        name: "ponpoko",
        about: "whose move",
        keys: [
          { key: "m", ...deal },
          { key: "shift+m", ...catchUp },
          { key: "t", ...thisTab },
          { key: "o", popup: command, name: "overview" },
          { key: "l", popup: [...command, "log"], name: "log", width: 90, height: 75 },
        ],
      },
    ],
  };
}
`;
}

type Item = { label: string; state: () => "installed" | "missing" | "different"; detail: string; install: () => string; remove: () => string };

export function items(places: Places, exec: Run = run): Item[] {
  const unit = join(places.config, "systemd", "user", "ponpoko.service");
  const plugin = join(places.config, "komux", "plugins", "ponpoko.ts");
  const fileItem = (label: string, path: string, text: string, after: () => string = () => ""): Item => ({
    label,
    detail: path,
    state: () => (!existsSync(path) ? "missing" : readFileSync(path, "utf8") === text ? "installed" : "different"),
    install: () => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      return `wrote ${path}${after()}`;
    },
    remove: () => {
      if (!existsSync(path)) return "not there";
      rmSync(path);
      return `removed ${path}`;
    },
  });
  const skills: Link[] = readdirSync(join(places.root, "skills")).map((name) => ({ source: join(places.root, "skills", name), target: join(places.claude, "skills", name), tail: join("skills", name), owner: "ponpoko" }));
  return [
    {
      ...fileItem("service", unit, unitText(places), () => {
        exec(["systemctl", "--user", "daemon-reload"]);
        const started = exec(["systemctl", "--user", "enable", "--now", "ponpoko.service"]);
        exec(["systemctl", "--user", "restart", "ponpoko.service"]);
        return started.ok ? ", enabled and started it" : `; enabling it failed: ${started.output}`;
      }),
      remove: () => {
        exec(["systemctl", "--user", "disable", "--now", "ponpoko.service"]);
        if (!existsSync(unit)) return "not there";
        rmSync(unit);
        exec(["systemctl", "--user", "daemon-reload"]);
        return `stopped it and removed ${unit}`;
      },
    },
    fileItem("komux plugin", plugin, pluginText(places)),
    ...skills.map(
      (link): Item => ({
        label: `skill ${link.tail.split("/").at(-1)}`,
        detail: link.target,
        state: () => {
          const state = linkState(link);
          return state === "installed" ? "installed" : state === "missing" ? "missing" : "different";
        },
        install: () => {
          const backup = applyLink(link);
          return backup ? `linked, keeping the old one as ${backup}` : "linked";
        },
        remove: () => removeLink(link),
      }),
    ),
    {
      label: "MCP",
      detail: "ponpoko in Claude Code's user config",
      state: () => (exec(["claude", "mcp", "get", "ponpoko"]).ok ? "installed" : "missing"),
      install: () => {
        const added = exec(["claude", "mcp", "add", "--scope", "user", "ponpoko", "--", places.bun, places.cli, "mcp"]);
        return added.ok ? "added" : `failed: ${added.output}`;
      },
      remove: () => (exec(["claude", "mcp", "remove", "--scope", "user", "ponpoko"]).ok ? "removed" : "not there"),
    },
  ];
}

export function komuxConfigHint(places: Places): string {
  const path = join(places.config, "komux", "config.ts");
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (text.includes("plugins/ponpoko")) return `komux's config already loads the plugin (${path}).`;
  return `Add these two lines to ${path}, then restart komux:

  import ponpoko from "./plugins/ponpoko.ts";
  plugins: [ponpoko()],        // inside the exported config; ponpoko({ deal: "alt+m" }) picks the keys

Alt m deals your oldest move, Alt shift m deals what changed since you last caught up,
and the tray shows your count. Ctrl Space m opens ponpoko's mode: m and M deal the same
way, t opens the current tab's strands, and o opens the overview the tray opens.
Give a layout labels: { strand: "sc-{story}" } so agents in its tabs work on that strand
once it exists; elsewhere a Claude counts once it reports a strand or you point its directory at one. Alt n is komux's focus key, so ponpoko doesn't take it.`;
}

const marks = { installed: "✓", missing: "✗", different: "!" };

export function setupCommand(args: string[], places = defaultPlaces(), exec: Run = run): number {
  const [flag, ...extra] = args;
  if (extra.length > 0 || (flag !== undefined && flag !== "--yes" && flag !== "--remove")) {
    console.error(usage);
    return 2;
  }
  const list = items(places, exec);
  const width = Math.max(...list.map((item) => item.label.length));
  if (flag === "--remove") {
    for (const item of list) console.log(`  ${item.label.padEnd(width)}  ${item.remove()}`);
    console.log("\nTake the ponpoko lines out of komux's config too, if you added them.");
    return 0;
  }
  if (flag === "--yes") {
    for (const item of list) {
      if (item.state() === "installed") continue;
      try {
        console.log(`  ${marks.installed} ${item.label.padEnd(width)}  ${item.install()}`);
      } catch (error) {
        console.log(`  ${marks.missing} ${item.label.padEnd(width)}  ${(error as Error).message}`);
      }
    }
    console.log(`\n${komuxConfigHint(places)}`);
    return 0;
  }
  console.log("ponpoko setup:\n");
  for (const item of list) {
    const state = item.state();
    console.log(`  ${marks[state]} ${item.label.padEnd(width)}  ${state === "installed" ? "in place" : state === "missing" ? "missing" : "out of date"}  ${item.detail}`);
  }
  console.log(`\nRun \`ponpoko setup --yes\` to install what's missing.\n\n${komuxConfigHint(places)}`);
  return 0;
}
