import { basename } from "node:path";

export type BraidRef = { id: string; name: string; kind?: "side" };

export function braidForDir(dir: string, pointed: Map<string, string>): BraidRef {
  let best: { dir: string; braid: string } | undefined;
  for (const [pointedDir, braid] of pointed) {
    if ((dir === pointedDir || dir.startsWith(`${pointedDir}/`)) && (!best || pointedDir.length > best.dir.length)) best = { dir: pointedDir, braid };
  }
  if (best) return { id: best.braid, name: best.braid };
  const story = /\/stories\/(sc-\d+)(?:\/|$)/i.exec(dir);
  if (story) return { id: story[1]!.toLowerCase(), name: story[1]!.toUpperCase() };
  const name = basename(dir) || dir || "unplaced";
  return { id: `side:${dir}`, name, kind: "side" };
}

export function storyNumber(braid: string): number | undefined {
  const match = /^sc-(\d+)$/.exec(braid);
  return match ? Number(match[1]) : undefined;
}
