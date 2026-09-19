import { execa } from "execa";
import { checkNow } from "../update/check.js";
import { currentInstall, updateCommand } from "../update/install.js";
import { readPackageInfo } from "../update/version.js";
import { banner, p, pc, unwrap } from "../ui/theme.js";

export async function runUpdate(opts: { check?: boolean; yes?: boolean }): Promise<void> {
  banner();
  p.intro(pc.bgMagenta(pc.black(" update ")));
  const { name } = readPackageInfo();
  const method = currentInstall();

  const spin = p.spinner();
  spin.start("Checking for updates");
  const { current, latest, newer } = await checkNow();
  if (!latest) {
    spin.stop(pc.yellow("Couldn't reach the registry"));
    p.outro(`Installed: ${current}. The package may not be published yet, or you're offline.`);
    return;
  }
  spin.stop(newer ? `New version found: ${pc.dim(current)} → ${pc.green(latest)}` : `You're on the latest version (${current})`);
  if (!newer) {
    p.outro(pc.green("Up to date ✔"));
    return;
  }
  if (opts.check) {
    p.outro(`Run ${pc.cyan("aicommit update")} to install ${latest}.`);
    return;
  }

  const cmd = updateCommand(method, name);
  if (!cmd) {
    p.outro(
      method === "dev"
        ? `Running from a source checkout: ${pc.cyan("git pull && pnpm install && pnpm build")}`
        : `Installed via npx, which fetches fresh copies: ${pc.cyan(`npx ${name}@latest`)}`,
    );
    return;
  }

  const [bin, args] = cmd;
  const ok = opts.yes || unwrap(await p.confirm({ message: `Run ${pc.cyan(`${bin} ${args.join(" ")}`)}?` }));
  if (!ok) {
    p.cancel("Update skipped.");
    return;
  }

  const run = p.spinner();
  run.start(`Installing ${name}@${latest}`);
  try {
    await execa(bin, args);
    run.stop(pc.green(`Updated to ${latest}`));
    p.outro("Restart your terminal if the command doesn't reflect the new version.");
  } catch (err) {
    run.stop(pc.red("Update failed"));
    const e = err as { stderr?: string; message: string };
    p.log.error((e.stderr || e.message).split("\n").slice(-6).join("\n"));
    p.outro(`Try manually: ${pc.cyan(`${bin} ${args.join(" ")}`)}`);
    process.exit(1);
  }
}
