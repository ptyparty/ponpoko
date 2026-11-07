import { z } from "zod";

export const whoseValues = ["you", "agent", "machine", "person", "nobody"] as const;
export type Whose = (typeof whoseValues)[number];
export type BraidKind = "story" | "epic" | "side" | "idea";
export type StrandKind = "agent" | "job" | "report";
export type Source = string;

export const place = z.looseObject({ adapter: z.string(), handle: z.string().optional(), dir: z.string().optional() });
export type Place = z.infer<typeof place>;

export const fact = z.discriminatedUnion("type", [
  z.object({ type: z.literal("braid.made"), braid: z.string(), name: z.string(), kind: z.enum(["story", "epic", "side", "idea"]).optional(), dir: z.string().optional() }),
  z.object({ type: z.literal("braid.titled"), braid: z.string(), kind: z.enum(["story", "epic"]), title: z.string() }),
  z.object({ type: z.literal("braid.note"), braid: z.string(), text: z.string() }),
  z.object({ type: z.literal("braid.seen"), braid: z.string() }),
  z.object({ type: z.literal("dir.pointed"), dir: z.string(), braid: z.string() }),
  z.object({
    type: z.literal("strand.move"),
    braid: z.string().optional(),
    strand: z.string(),
    label: z.string(),
    kind: z.enum(["agent", "job", "report"]),
    whose: z.enum(whoseValues),
    who: z.string().optional(),
    why: z.string(),
    place: place.optional(),
  }),
  z.object({ type: z.literal("strand.ended"), strand: z.string(), why: z.string() }),
  z.object({ type: z.literal("strand.status"), strand: z.string(), text: z.string(), page: z.string().optional() }),
  z.object({ type: z.literal("strand.dismissed"), strand: z.string() }),
  z.object({ type: z.literal("strand.seen"), strand: z.string() }),
  z.object({ type: z.literal("strand.snoozed"), strand: z.string(), until: z.number() }),
  z.object({ type: z.literal("strand.forgotten"), strand: z.string() }),
]);

export type Fact = z.infer<typeof fact>;
export type Recorded = Fact & { id: number; at: number; source: Source };
