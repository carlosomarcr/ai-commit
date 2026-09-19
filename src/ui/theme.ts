import * as p from "@clack/prompts";
import pc from "picocolors";

export const banner = () =>
  console.log(`\n  ${pc.bold(pc.magenta("◆ aicommit"))} ${pc.dim("· AI-powered git commits")}\n`);

export const statusColor: Record<string, (s: string) => string> = {
  A: pc.green,
  M: pc.yellow,
  D: pc.red,
  R: pc.cyan,
  "?": pc.green,
};

/** clack returns a symbol on Ctrl+C; exit cleanly instead of crashing on it. */
export function unwrap<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) {
    p.cancel("Cancelled");
    process.exit(0);
  }
  return value as Exclude<T, symbol>;
}

export { p, pc };
