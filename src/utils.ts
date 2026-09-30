export function readStdin<T>(): Promise<T> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (buffer += chunk));
    process.stdin.once("error", reject);
    process.stdin.on("end", () => {
      if (!buffer.trim()) return reject(new Error("empty hook stdin"));
      try {
        resolve(JSON.parse(buffer) as T);
      } catch (error) {
        reject(
          new Error(`invalid hook JSON: ${error instanceof Error ? error.message : String(error)}`),
        );
      }
    });
  });
}

export function toText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n…[truncated]`;
}

let debug = false;
export function setDebug(value: boolean): void {
  debug = value;
}
export function debugLog(...args: unknown[]): void {
  if (debug) console.error("[litefuse-minimax]", ...args);
}
