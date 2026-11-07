export type BraidRef = { id: string; name: string };

export function braidRef(braid: string): BraidRef {
  const id = braid.toLowerCase();
  return { id, name: id };
}

export function pointedBraid(dir: string, pointed: Map<string, string>): string | undefined {
  let best: { dir: string; braid: string } | undefined;
  for (const [pointedDir, braid] of pointed) {
    if ((dir === pointedDir || dir.startsWith(`${pointedDir}/`)) && (!best || pointedDir.length > best.dir.length)) best = { dir: pointedDir, braid };
  }
  return best?.braid;
}

export function tabBraid(tab: { dir: string; labels?: Record<string, string> }, pointed: Map<string, string>): BraidRef | undefined {
  const label = tab.labels?.braid;
  const named = label && !/\{[\w-]+\}/.test(label) ? label : pointedBraid(tab.dir, pointed);
  return named ? braidRef(named) : undefined;
}

export function storyNumber(braid: string): number | undefined {
  const match = /^sc-(\d+)$/.exec(braid);
  return match ? Number(match[1]) : undefined;
}
