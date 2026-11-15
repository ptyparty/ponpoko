import { expect, test } from "bun:test";
import { openScreen } from "./screen.ts";

test("a SIGWINCH with no resize wakes the screen once, as komux sends when it brings a popup back; a resize only redraws", async () => {
  const write = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  let resized = 0;
  let woken = 0;
  try {
    const screen = openScreen(
      () => undefined,
      () => void resized++,
      () => void woken++,
    );
    process.emit("SIGWINCH", "SIGWINCH");
    process.emit("SIGWINCH", "SIGWINCH");
    await Bun.sleep(60);
    expect([resized, woken]).toEqual([0, 1]);
    process.emit("SIGWINCH", "SIGWINCH");
    process.stdout.emit("resize");
    await Bun.sleep(60);
    expect([resized, woken]).toEqual([1, 1]);
    screen.close();
    process.emit("SIGWINCH", "SIGWINCH");
    await Bun.sleep(60);
    expect(woken).toBe(1);
  } finally {
    process.stdout.write = write;
  }
});
