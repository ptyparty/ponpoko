import { z } from "zod";

export const playerKinds = ["you", "agent", "job", "person", "machine"] as const;
export type PlayerKind = (typeof playerKinds)[number];
export type Whose = "you" | "agent" | "person" | "machine";
export type Source = string;

const id = z.string().min(1);

export const fact = z.discriminatedUnion("type", [
  z.object({ type: z.literal("strand.made"), strand: id, name: z.string().min(1), parent: id.optional(), kind: z.string().optional() }),
  z.object({ type: z.literal("strand.titled"), strand: id, kind: z.string().optional(), title: z.string() }),
  z.object({ type: z.literal("strand.parented"), strand: id, parent: id.optional() }),
  z.object({ type: z.literal("strand.done"), strand: id, why: z.string() }),
  z.object({ type: z.literal("strand.forgotten"), strand: id }),
  z.object({ type: z.literal("strand.merged"), strand: id, into: id }),
  z.object({ type: z.literal("strand.note"), strand: id, text: z.string() }),
  z.object({ type: z.literal("strand.seen"), strand: id }),
  z.object({ type: z.literal("strand.dismissed"), strand: id }),
  z.object({ type: z.literal("strand.snoozed"), strand: id, until: z.number() }),
  z.object({
    type: z.literal("player.joined"),
    player: id,
    kind: z.enum(playerKinds),
    who: z.string(),
    adapter: z.string().optional(),
    place: z.looseObject({ handle: z.string().optional(), dir: z.string().optional() }).optional(),
    resume: z.string().optional(),
  }),
  z.object({ type: z.literal("player.gone"), player: id, why: z.string() }),
  z.object({ type: z.literal("move.opened"), move: id, strand: id, player: id, with: id.optional(), what: z.string() }),
  z.object({ type: z.literal("move.described"), move: id, what: z.string() }),
  z.object({ type: z.literal("move.closed"), move: id }),
  z.object({ type: z.literal("link.added"), link: id, strand: id.optional(), move: id.optional(), adapter: z.string().min(1), ref: z.string().min(1), label: z.string().optional() }),
  z.object({ type: z.literal("link.removed"), link: id }),
]);

export type Fact = z.infer<typeof fact>;
export type Recorded = Fact & { id: number; at: number; source: Source };
export type Place = NonNullable<Extract<Fact, { type: "player.joined" }>["place"]>;
