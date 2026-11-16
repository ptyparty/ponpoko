export type Title = { kind: "story" | "epic"; title: string };
export type TitleLookup = (name: string) => Promise<Title | undefined>;

export function storyNumber(name: string): number | undefined {
  const match = /^sc-(\d+)$/i.exec(name);
  return match ? Number(match[1]) : undefined;
}

export function isStory(strand: { name: string; kind?: string }): boolean {
  return storyNumber(strand.name) !== undefined || strand.kind === "story" || strand.kind === "epic";
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

export type EpicStory = { id: number; name: string; url?: string; completed: boolean; started: boolean; blocks: number[] };
export type EpicLookup = (epic: number) => Promise<EpicStory[]>;

export async function epicStories(epic: number, token = process.env.SHORTCUT_TOKEN): Promise<EpicStory[]> {
  if (!token) throw new Error("SHORTCUT_TOKEN isn't set");
  const response = await fetch(`https://api.app.shortcut.com/api/v3/epics/${epic}/stories`, { headers: { "Shortcut-Token": token, "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Shortcut answered ${response.status}`);
  return readEpicStories(await response.json());
}

export function readEpicStories(body: unknown): EpicStory[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((raw): EpicStory[] => {
    const story = raw as Record<string, unknown>;
    if (typeof story.id !== "number" || typeof story.name !== "string" || story.archived === true) return [];
    const links = Array.isArray(story.story_links) ? (story.story_links as Record<string, unknown>[]) : [];
    const blocks = links.filter((link) => link.verb === "blocks" && link.subject_id === story.id && typeof link.object_id === "number").map((link) => link.object_id as number);
    return [{ id: story.id, name: story.name, ...(typeof story.app_url === "string" ? { url: story.app_url } : {}), completed: story.completed === true, started: story.started === true, blocks }];
  });
}
