import { expect, test } from "bun:test";
import { openScreen } from "./screen.ts";

test("a SIGWINCH reaches the screen while it's open, as komux sends when it brings a popup back", () => {
  const write = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  let resized = 0;
  try {
    const screen = openScreen(() => undefined, () => void resized++);
    process.emit("SIGWINCH", "SIGWINCH");
    expect(resized).toBe(1);
    screen.close();
    process.emit("SIGWINCH", "SIGWINCH");
    expect(resized).toBe(1);
  } finally {
    process.stdout.write = write;
  }
});
