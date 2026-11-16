import type { Knowledge } from "./core.ts";
import type { Fact } from "./events.ts";
import { storyNumber, type EpicStory } from "./shortcut.ts";

export const importAdapter = "shortcut-import-state";
export const shortcutAdapter = "shortcut";
const importVersion = "3";

function importRef(epic: number): string {
  return `epic:${epic}@${importVersion}`;
}

export function epicsToImport(knowledge: Knowledge): { strand: string; epic: number }[] {
  const imported = new Set(knowledge.links.filter((link) => link.adapter === importAdapter && link.strand && link.ref.endsWith(`@${importVersion}`)).map((link) => link.strand!));
  return knowledge.strands.flatMap((strand) => {
    const epic = storyNumber(strand.name);
    return strand.kind === "epic" && epic !== undefined && !imported.has(strand.id) ? [{ strand: strand.id, epic }] : [];
  });
}

export function epicChanges(facts: Fact[]): string {
  const count = (type: Fact["type"]) => facts.filter((fact) => fact.type === type).length;
  const plural = (number: number, one: string, many: string) => `${number} ${number === 1 ? one : many}`;
  const held = facts.filter((fact) => fact.type === "strand.held" && fact.held).length;
  const parts = [plural(count("strand.made"), "new story", "new stories"), plural(count("strand.blocked"), "new dependency", "new dependencies"), ...(count("strand.parented") > 0 ? [plural(count("strand.parented"), "story moved under the epic", "stories moved under the epic")] : []), ...(count("strand.forgotten") > 0 ? [`${plural(count("strand.forgotten"), "story", "stories")} not ready yet dropped`] : []), ...(held > 0 ? [`${plural(held, "story waits", "stories wait")} on stories not in ponpoko yet`] : [])];
  return parts.join(", ");
}

export function epicFacts(knowledge: Knowledge, epicStrand: string, epic: number, stories: EpicStory[], newId: (prefix: string) => string): Fact[] {
  const facts: Fact[] = [];
  const all = [...knowledge.strands, ...knowledge.closed];
  const named = (number: number) => all.filter((strand) => strand.name.toLowerCase() === `sc-${number}`);
  const live = new Set(knowledge.strands.map((strand) => strand.id));
  const ids = new Map<number, string>();
  const blockedOn = new Map(all.map((strand) => [strand.id, new Set(Object.keys(strand.blockedOn))]));
  const forgotten = new Set((knowledge.forgotten ?? []).filter((strand) => strand.by !== "shortcut").map((strand) => strand.name.toLowerCase()));
  const released = new Map(all.map((strand) => [strand.id, new Set(Object.keys(strand.released ?? {}))]));
  const linked = new Set(knowledge.links.filter((link) => link.adapter === shortcutAdapter && link.strand).map((link) => link.strand!));
  for (const story of stories) {
    const found = named(story.id);
    const existing = found.find((strand) => strand.parent === epicStrand) ?? found.find((strand) => live.has(strand.id)) ?? found[0];
    if (existing) {
      ids.set(story.id, existing.id);
      if (live.has(existing.id) && existing.parent === undefined && existing.id !== epicStrand) facts.push({ type: "strand.parented", strand: existing.id, parent: epicStrand });
      if (!existing.title && live.has(existing.id)) facts.push({ type: "strand.titled", strand: existing.id, kind: "story", title: story.name });
    } else if (!forgotten.has(`sc-${story.id}`) && story.stage !== "later") {
      const id = newId("s");
      ids.set(story.id, id);
      facts.push({ type: "strand.made", strand: id, name: `sc-${story.id}`, parent: epicStrand, kind: "story" });
      facts.push({ type: "strand.titled", strand: id, kind: "story", title: story.name });
      if (story.completed || story.stage === "done") facts.push({ type: "strand.done", strand: id, why: "done in Shortcut" });
      else facts.push({ type: "strand.planned", strand: id, planned: true });
    }
    if (story.url && ids.has(story.id) && !linked.has(ids.get(story.id)!)) facts.push({ type: "link.added", link: newId("l"), strand: ids.get(story.id)!, adapter: shortcutAdapter, ref: story.url, label: `sc-${story.id}` });
  }
  const workspace = stories.map((story) => /^(https:\/\/app\.shortcut\.com\/[^/]+)\//.exec(story.url ?? "")?.[1]).find(Boolean);
  if (workspace && !linked.has(epicStrand)) facts.push({ type: "link.added", link: newId("l"), strand: epicStrand, adapter: shortcutAdapter, ref: `${workspace}/epic/${epic}`, label: `sc-${epic}` });
  const later = new Set(stories.filter((story) => story.stage === "later").map((story) => `sc-${story.id}`));
  const parents = new Set(knowledge.strands.flatMap((strand) => (strand.parent ? [strand.parent] : [])));
  const kept = new Set(knowledge.links.filter((link) => link.strand && link.adapter !== shortcutAdapter).map((link) => link.strand!));
  const dropped = new Set<string>();
  for (const strand of knowledge.strands) {
    const untouched = strand.parent === epicStrand && strand.madeBy === "shortcut" && strand.planned && strand.notes.length === 0 && !parents.has(strand.id) && !kept.has(strand.id);
    if (untouched && later.has(strand.name.toLowerCase())) dropped.add(strand.id);
  }
  for (const [story, strand] of ids) if (dropped.has(strand)) ids.delete(story);
  const strandOf = (number: number) => ids.get(number) ?? all.find((strand) => strand.name.toLowerCase() === `sc-${number}` && !dropped.has(strand.id))?.id;
  const block = (strand: string | undefined, on: string | undefined) => {
    if (!on || !strand || on === strand || blockedOn.get(strand)?.has(on) || released.get(strand)?.has(on)) return;
    facts.push({ type: "strand.blocked", strand, on });
    blockedOn.set(strand, new Set([...(blockedOn.get(strand) ?? []), on]));
  };
  for (const story of stories) {
    for (const blocked of story.blocks) block(ids.get(blocked), ids.get(story.id));
    for (const blocker of story.blockedBy ?? []) block(ids.get(story.id), strandOf(blocker.id));
  }
  const made = new Set(facts.flatMap((fact) => (fact.type === "strand.made" ? [fact.strand] : [])));
  const known = new Map(knowledge.strands.map((strand) => [strand.id, strand]));
  for (const story of stories) {
    const strand = ids.get(story.id);
    const current = strand ? known.get(strand) : undefined;
    if (!strand || story.completed || story.stage === "done" || !(made.has(strand) || (current?.madeBy === "shortcut" && current.planned))) continue;
    const outside = new Set((story.blockedBy ?? []).filter((blocker) => !blocker.done && !strandOf(blocker.id)).map((blocker) => `sc-${blocker.id}`));
    const held = new Set(Object.keys(current?.heldBy ?? {}));
    for (const by of outside) if (!held.has(by)) facts.push({ type: "strand.held", strand, by, held: true });
    for (const by of held) if (!outside.has(by)) facts.push({ type: "strand.held", strand, by, held: false });
  }
  for (const strand of dropped) facts.push({ type: "strand.forgotten", strand });
  if (!knowledge.links.some((link) => link.strand === epicStrand && link.adapter === importAdapter && link.ref === importRef(epic))) facts.push({ type: "link.added", link: newId("l"), strand: epicStrand, adapter: importAdapter, ref: importRef(epic) });
  return facts;
}
