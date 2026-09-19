import { execa } from "execa";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "../git/git.js";

const HELP = "\n# Edit the commit message above. Lines starting with # are ignored.\n# Leave it empty to keep the original.\n";

/** Drops comment lines (like git does) and trims the result. */
export function stripComments(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => !l.startsWith("#"))
    .join("\n")
    .trim();
}

/**
 * Opens the user's editor (git's own choice: GIT_EDITOR, core.editor, $VISUAL, $EDITOR) on the
 * message and returns the edited text, or null when the editor failed or the text came back empty.
 */
export async function editInEditor(initial: string): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "gitowl-"));
  const file = join(dir, "COMMIT_EDITMSG");
  try {
    await writeFile(file, initial + "\n" + HELP);
    const editor = await git.editorCommand();
    // Through a shell so editors configured with arguments ("code --wait") work on every platform.
    await execa(`${editor} "${file}"`, { shell: true, stdio: "inherit" });
    const edited = stripComments(await readFile(file, "utf8"));
    return edited || null;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
