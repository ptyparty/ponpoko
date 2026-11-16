import { configFile, readConfig } from "./github.ts";
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

export type Stage = "ready" | "started" | "done" | "later";
export type EpicStory = { id: number; name: string; url?: string; completed: boolean; started: boolean; blocks: number[]; blockedBy?: { id: number; done: boolean }[]; stage?: Stage };
export type EpicLookup = (epic: number) => Promise<EpicStory[]>;
export type WorkflowState = { name: string; type: string };

export const defaultReadyStates = ["Ready", "Ready for Development"];

export function readyStates(file = configFile()): string[] {
  const given = readConfig(file).shortcut?.readyStates;
  return Array.isArray(given) && given.length > 0 && given.every((state) => typeof state === "string") ? given : defaultReadyStates;
}

export function stageOf(state: WorkflowState | undefined, story: { completed: boolean; started: boolean }, ready: string[] = defaultReadyStates): Stage {
  if (story.completed || state?.type === "done") return "done";
  if (state?.type === "started" || (!state && story.started)) return "started";
  if (state && ready.some((name) => name.trim().toLowerCase() === state.name.trim().toLowerCase())) return "ready";
  return "later";
}

async function shortcutGet(path: string, token: string): Promise<unknown> {
  const response = await fetch(`https://api.app.shortcut.com/api/v3/${path}`, { headers: { "Shortcut-Token": token, "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Shortcut answered ${response.status}`);
  return response.json();
}

export async function epicStories(epic: number, token = process.env.SHORTCUT_TOKEN, ready = readyStates()): Promise<EpicStory[]> {
  if (!token) throw new Error("SHORTCUT_TOKEN isn't set");
  const [stories, workflows] = await Promise.all([shortcutGet(`epics/${epic}/stories`, token), shortcutGet("workflows", token)]);
  return readEpicStories(stories, readWorkflowStates(workflows), ready);
}

export function readWorkflowStates(body: unknown): Map<number, WorkflowState> {
  const states = new Map<number, WorkflowState>();
  if (!Array.isArray(body)) return states;
  for (const workflow of body as { states?: { id?: unknown; name?: unknown; type?: unknown }[] }[]) {
    for (const state of workflow.states ?? []) if (typeof state.id === "number" && typeof state.name === "string" && typeof state.type === "string") states.set(state.id, { name: state.name, type: state.type });
  }
  return states;
}

export function readEpicStories(body: unknown, states = new Map<number, WorkflowState>(), ready = defaultReadyStates): EpicStory[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((raw): EpicStory[] => {
    const story = raw as Record<string, unknown>;
    if (typeof story.id !== "number" || typeof story.name !== "string" || story.archived === true) return [];
    const links = Array.isArray(story.story_links) ? (story.story_links as Record<string, unknown>[]) : [];
    const blocks = links.filter((link) => link.verb === "blocks" && link.subject_id === story.id && typeof link.object_id === "number").map((link) => link.object_id as number);
    const blockedBy = links
      .filter((link) => link.verb === "blocks" && link.object_id === story.id && typeof link.subject_id === "number")
      .map((link) => ({ id: link.subject_id as number, done: typeof link.subject_workflow_state_id === "number" && states.get(link.subject_workflow_state_id)?.type === "done" }));
    const flags = { completed: story.completed === true, started: story.started === true };
    const state = typeof story.workflow_state_id === "number" ? states.get(story.workflow_state_id) : undefined;
    return [{ id: story.id, name: story.name, ...(typeof story.app_url === "string" ? { url: story.app_url } : {}), ...flags, blocks, blockedBy, stage: stageOf(state, flags, ready) }];
  });
}
