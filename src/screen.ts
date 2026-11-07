export type Key = { name: string; text?: string };

export function parseKeys(data: string): Key[] {
  const keys: Key[] = [];
  let index = 0;
  while (index < data.length) {
    const rest = data.slice(index);
    const arrow = /^\x1b\[([ABCD])/.exec(rest);
    if (arrow) {
      keys.push({ name: { A: "up", B: "down", C: "right", D: "left" }[arrow[1] as "A"] });
      index += 3;
      continue;
    }
    const char = data[index]!;
    index++;
    if (char === "\x1b") keys.push({ name: "escape" });
    else if (char === "\r" || char === "\n") keys.push({ name: "return" });
    else if (char === "\x7f" || char === "\b") keys.push({ name: "backspace" });
    else if (char === "\x03") keys.push({ name: "ctrl+c" });
    else if (char === "\t") keys.push({ name: "tab" });
    else if (char >= " ") keys.push({ name: char, text: char });
  }
  return keys;
}

export const style = {
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  dim: (text: string) => `\x1b[2m${text}\x1b[22m`,
  amber: (text: string) => `\x1b[38;5;214m${text}\x1b[39m`,
  cyan: (text: string) => `\x1b[36m${text}\x1b[39m`,
  magenta: (text: string) => `\x1b[35m${text}\x1b[39m`,
  red: (text: string) => `\x1b[31m${text}\x1b[39m`,
  reverse: (text: string) => `\x1b[7m${text}\x1b[27m`,
};

export type Screen = { width: number; height: number; draw: (lines: string[]) => void; close: () => void };

export function openScreen(onKey: (key: Key) => void, onResize: () => void): Screen {
  const out = process.stdout;
  out.write("\x1b[?1049h\x1b[?25l");
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  const listener = (data: string) => {
    for (const key of parseKeys(data)) onKey(key);
  };
  process.stdin.on("data", listener);
  out.on("resize", onResize);
  const screen: Screen = {
    get width() {
      return out.columns ?? 100;
    },
    get height() {
      return out.rows ?? 30;
    },
    draw: (lines) => {
      out.write(`\x1b[H${lines.slice(0, screen.height).map((line) => `${line}\x1b[K`).join("\r\n")}\x1b[J`);
    },
    close: () => {
      process.stdin.off("data", listener);
      out.off("resize", onResize);
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      out.write("\x1b[?25h\x1b[?1049l");
    },
  };
  return screen;
}
