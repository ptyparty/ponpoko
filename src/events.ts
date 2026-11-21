import { z } from "zod";

export const playerKinds = ["you", "agent", "job", "person", "machine"] as const;
export type PlayerKind = (typeof playerKinds)[number];
export type Whose = "you" | "agent" | "person" | "machine";
export type Source = string;

const id = z.string().min(1);

export const to = z.union([z.object({ person: id }), z.object({ group: id }), z.object({ service: id }), z.object({ role: z.string().min(1), strand: id })]);
export type To = z.infer<typeof to>;
export const replyKinds = ["done", "declined", "withdrawn", "progress", "passed"] as const;
export type ReplyKind = (typeof replyKinds)[number];
export const activities = ["working", "background", "job", "idle"] as const;
export type ActivityKind = (typeof activities)[number];
const request = z.object({ request: id, strand: id, to, what: z.string(), kind: z.string().optional(), ref: z.string().optional(), from: id.optional() });
const reply = z.object({ request: id, as: z.enum(replyKinds), to: to.optional(), what: z.string().optional(), by: id.optional() });
export type RequestSaid = z.infer<typeof request>;
export type ReplySaid = z.infer<typeof reply>;

export const fact = z.discriminatedUnion("type", [
  z.object({ type: z.literal("strand.made"), strand: id, name: z.string().min(1), parent: id.optional(), kind: z.string().optional() }),
  z.object({ type: z.literal("strand.titled"), strand: id, kind: z.string().optional(), title: z.string() }),
  z.object({ type: z.literal("strand.parented"), strand: id, parent: id.optional() }),
  z.object({ type: z.literal("strand.renamed"), strand: id, name: z.string().min(1) }),
  z.object({ type: z.literal("strand.done"), strand: id, why: z.string() }),
  z.object({ type: z.literal("strand.reopened"), strand: id }),
  z.object({ type: z.literal("strand.forgotten"), strand: id }),
  z.object({ type: z.literal("strand.merged"), strand: id, into: id }),
  z.object({ type: z.literal("strand.note"), strand: id, text: z.string() }),
  z.object({ type: z.literal("strand.blocked"), strand: id, on: id }),
  z.object({ type: z.literal("strand.planned"), strand: id, planned: z.boolean() }),
  z.object({ type: z.literal("strand.held"), strand: id, by: z.string().min(1), held: z.boolean() }),
  z.object({ type: z.literal("strand.unblocked"), strand: id, on: id }),
  z.object({ type: z.literal("strand.seen"), strand: id }),
  z.object({ type: z.literal("strand.dismissed"), strand: id }),
  z.object({ type: z.literal("strand.snoozed"), strand: id, until: z.number(), untilNeeded: z.boolean().optional() }),
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
  z.object({ type: z.literal("move.opened"), move: id, strand: id, player: id, with: id.optional(), what: z.string(), kind: z.string().optional() }),
  z.object({ type: z.literal("move.described"), move: id, what: z.string(), kind: z.string().optional() }),
  z.object({ type: z.literal("move.closed"), move: id }),
  z.object({ type: z.literal("link.added"), link: id, strand: id.optional(), move: id.optional(), adapter: z.string().min(1), ref: z.string().min(1), label: z.string().optional() }),
  z.object({ type: z.literal("link.removed"), link: id }),
  z.object({ type: z.literal("party.known"), party: id, kind: z.enum(["person", "group", "service"]), name: z.string().min(1), handles: z.record(z.string(), z.string()).optional(), members: z.array(id).optional() }),
  z.object({ type: z.literal("party.merged"), party: id, into: id }),
  z.object({ type: z.literal("strand.role"), strand: id, role: z.string().min(1), by: id.optional() }),
  z.object({ type: z.literal("said"), requests: z.array(request).default([]), replies: z.array(reply).default([]) }),
  z.object({ type: z.literal("handed"), player: id, requests: z.array(id) }),
  z.object({ type: z.literal("player.activity"), player: id, strand: id.optional(), activity: z.enum(activities), what: z.string().optional(), for: id.optional() }),
]);

export type Fact = z.infer<typeof fact>;
export type Recorded = Fact & { id: number; at: number; source: Source };
export type Place = NonNullable<Extract<Fact, { type: "player.joined" }>["place"]>;
