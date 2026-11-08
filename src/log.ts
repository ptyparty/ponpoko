import type { Snapshot } from "./core.ts";
import { clock, describe } from "./render.ts";
import { cells, keyLine, style, type Key } from "./screen.ts";

export class LogView {
  private snapshot: Snapshot | undefined;
  private top = 0;

  setSnapshot(snapshot: Snapshot | undefined): void {
    this.snapshot = snapshot;
  }

  key(key: Key, height: number): "close" | undefined {
    const room = this.room(height);
    const last = Math.max(0, (this.snapshot?.heard.length ?? 0) - room);
    switch (key.name) {
      case "escape":
      case "q":
      case "l":
      case "ctrl+c":
        return "close";
      case "j":
      case "down":
        this.top = Math.min(this.top + 1, last);
        return undefined;
      case "k":
      case "up":
        this.top = Math.max(this.top - 1, 0);
        return undefined;
      case " ":
      case "f":
        this.top = Math.min(this.top + room, last);
        return undefined;
      case "b":
        this.top = Math.max(this.top - room, 0);
        return undefined;
      case "g":
        this.top = 0;
        return undefined;
      case "G":
        this.top = last;
        return undefined;
    }
    return undefined;
  }

  view(width: number, height: number): string[] {
    if (!this.snapshot) return [" ◆ ponpoko log", "", style.red(" ponpoko ✗  the service isn't running"), "", keyLine([["esc", "close"]])];
    const log = this.snapshot.heard;
    const room = this.room(height);
    this.top = Math.min(this.top, Math.max(0, log.length - room));
    const title = cells([[" ◆ ", (text) => style.accent(style.bold(text))], ["log", (text) => style.text(style.bold(text))], [`   newest first · ${log.length}`, style.muted]], width);
    const lines = log.slice(this.top, this.top + room).map((event) => cells([" ", [clock(event.at), style.faint], "  ", [event.source.padEnd(7), style.muted], [describe(event, this.snapshot!.labels), style.text]], width));
    if (log.length === 0) lines.push(style.muted(" nothing in the log yet"));
    while (lines.length < room) lines.push("");
    return [style.surface(title), "", ...lines, "", keyLine([["j k", "scroll"], ["␣ b", "page"], ["g G", "newest, oldest"], ["esc", "close"]])];
  }

  private room(height: number): number {
    return Math.max(3, height - 4);
  }
}
