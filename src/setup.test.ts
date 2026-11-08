import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupCommand, type Places } from "./setup.ts";

const dir = mkdtempSync(join(tmpdir(), "ponpoko-setup-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const places: Places = {
  home: dir,
  config: join(dir, "config"),
  claude: join(dir, "claude"),
  bun: "/usr/bin/bun",
  cli: "/repo/src/cli.ts",
  root: join(import.meta.dir, ".."),
};

describe("ponpoko setup", () => {
  test("installs the unit, plugin, skill and MCP, and only prints komux's config lines", () => {
    const ran: string[][] = [];
    let mcp = false;
    const exec = (command: string[]) => {
      ran.push(command);
      if (command[1] === "mcp" && command[2] === "add") mcp = true;
      return { ok: command[2] !== "get" || mcp, output: "" };
    };
    mkdirSync(join(places.config, "komux"), { recursive: true });
    writeFileSync(join(places.config, "komux", "config.ts"), "export default {};\n");
    const log = spyOn(console, "log").mockImplementation(() => {});
    expect(setupCommand(["--yes"], places, exec)).toBe(0);
    const printed = log.mock.calls.flat().join("\n");
    log.mockRestore();
    expect(readFileSync(join(places.config, "systemd", "user", "ponpoko.service"), "utf8")).toContain("ExecStart=/usr/bin/bun /repo/src/cli.ts serve");
    expect(readFileSync(join(places.config, "komux", "plugins", "ponpoko.ts"), "utf8")).toContain('popup: [...command, "deal"]');
    expect(lstatSync(join(places.claude, "skills", "ponpoko")).isSymbolicLink()).toBe(true);
    expect(ran).toContainEqual(["systemctl", "--user", "enable", "--now", "ponpoko.service"]);
    expect(ran).toContainEqual(["claude", "mcp", "add", "--scope", "user", "ponpoko", "--", "/usr/bin/bun", "/repo/src/cli.ts", "mcp"]);
    expect(printed).toContain('import ponpoko from "./plugins/ponpoko.ts";');
    expect(readFileSync(join(places.config, "komux", "config.ts"), "utf8")).toBe("export default {};\n");

    spyOn(console, "log").mockImplementation(() => {});
    setupCommand(["--remove"], places, exec);
    expect(existsSync(join(places.config, "komux", "plugins", "ponpoko.ts"))).toBe(false);
    expect(existsSync(join(places.claude, "skills", "ponpoko"))).toBe(false);
  });

  test("the plugin is a komux config slice", async () => {
    const path = join(dir, "plugin.ts");
    writeFileSync(path, (await import("./setup.ts")).pluginText(places));
    const ponpoko = (await import(path)).default;
    expect(ponpoko({ deal: "alt+y" }).keys.map((binding: { key: string }) => binding.key)).toEqual(["alt+y", "alt+shift+m"]);
    const [mode] = ponpoko().modes;
    expect(mode.key).toBe("m");
    expect(mode.keys.map((binding: { key: string }) => binding.key)).toEqual(["m", "shift+m", "t", "o"]);
    expect(ponpoko({ leader: "y" }).modes[0].key).toBe("y");
  });
});
