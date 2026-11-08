export type Title = { kind: "story" | "epic"; title: string };
export type TitleLookup = (name: string) => Promise<Title | undefined>;

export function storyNumber(name: string): number | undefined {
  const match = /^sc-(\d+)$/i.exec(name);
  return match ? Number(match[1]) : undefined;
}

export async function shortcutTitle(name: string, token = process.env.SHORTCUT_TOKEN): Promise<Title | undefined> {
  const number = storyNumber(name);
  if (number === undefined) return undefined;
  if (!token) throw new Error("SHORTCUT_TOKEN isn't set");
  const headers = { "Shortcut-Token": token, "Content-Type": "application/json" };
  for (const kind of ["story", "epic"] as const) {
    const response = await fetch(`https://api.app.shortcut.com/api/v3/${kind === "story" ? "stories" : "epics"}/${number}`, { headers, signal: AbortSignal.timeout(10_000) });
    if (response.ok) {
      const body = (await response.json()) as { name?: string };
      return body.name ? { kind, title: body.name } : undefined;
    }
    if (response.status !== 404) throw new Error(`Shortcut answered ${response.status}`);
  }
  return undefined;
}
