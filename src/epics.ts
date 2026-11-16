import type { Knowledge } from "./core.ts";
import type { Fact } from "./events.ts";
import { storyNumber, type EpicStory } from "./shortcut.ts";

export const importAdapter = "shortcut-import-state";
export const shortcutAdapter = "shortcut";
const importVersion = "2";

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
  const parts = [plural(count("strand.made"), "new story", "new stories"), plural(count("strand.blocked"), "new dependency", "new dependencies"), ...(count("strand.parented") > 0 ? [plural(count("strand.parented"), "story moved under the epic", "stories moved under the epic")] : []), ...(count("strand.forgotten") > 0 ? [`${plural(count("strand.forgotten"), "story", "stories")} not ready yet dropped`] : [])];
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
  for (const story of stories) {
    for (const blocked of story.blocks) {
      const on = ids.get(story.id);
      const strand = ids.get(blocked);
      if (!on || !strand || on === strand || blockedOn.get(strand)?.has(on) || released.get(strand)?.has(on)) continue;
      facts.push({ type: "strand.blocked", strand, on });
      blockedOn.set(strand, new Set([...(blockedOn.get(strand) ?? []), on]));
    }
  }
  const later = new Set(stories.filter((story) => story.stage === "later").map((story) => `sc-${story.id}`));
  const parents = new Set(knowledge.strands.flatMap((strand) => (strand.parent ? [strand.parent] : [])));
  const kept = new Set(knowledge.links.filter((link) => link.strand && link.adapter !== shortcutAdapter).map((link) => link.strand!));
  for (const strand of knowledge.strands) {
    const untouched = strand.parent === epicStrand && strand.madeBy === "shortcut" && strand.planned && strand.notes.length === 0 && !parents.has(strand.id) && !kept.has(strand.id);
    if (untouched && later.has(strand.name.toLowerCase())) facts.push({ type: "strand.forgotten", strand: strand.id });
  }
  if (!knowledge.links.some((link) => link.strand === epicStrand && link.adapter === importAdapter && link.ref === importRef(epic))) facts.push({ type: "link.added", link: newId("l"), strand: epicStrand, adapter: importAdapter, ref: importRef(epic) });
  return facts;
}
