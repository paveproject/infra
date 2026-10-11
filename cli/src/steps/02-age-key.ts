import type { ListrTask } from "listr2";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { InstallCtx } from "../lib/context.js";
import { defaultAgeKeyPath, sopsYamlPath } from "../lib/paths.js";

const PLACEHOLDER = "age1REPLACE_ME_WITH_YOUR_AGE_PUBLIC_KEY";

/**
 * Doc: one dedicated Age key for this repo (kept separate from any other
 * project's key), used for every kubernetes/**\/*.sops.yaml secret. The
 * PRIVATE key never leaves ~/.config/sops/age/paveproject-infra.txt and is
 * never committed — BACK IT UP somewhere outside this machine (password
 * manager, etc.) right after it's generated. Losing it with no backup
 * makes every encrypted secret in this repo permanently unrecoverable.
 * Safe to re-run: only generates a key if one isn't there yet.
 */
export const ageKeyStep: ListrTask<InstallCtx> = {
  title: "Generate Age key for SOPS",
  task: async (ctx, task) => {
    ctx.ageKeyPath = defaultAgeKeyPath;

    if (!existsSync(defaultAgeKeyPath)) {
      task.output = `Generating new key at ${defaultAgeKeyPath}`;
      await mkdir(path.dirname(defaultAgeKeyPath), { recursive: true, mode: 0o700 });
      await execa("age-keygen", ["-o", defaultAgeKeyPath]);
    } else {
      task.output = `Using existing key at ${defaultAgeKeyPath}`;
    }

    const contents = await readFile(defaultAgeKeyPath, "utf8");
    const match = contents.match(/# public key: (age1[a-z0-9]+)/i);
    if (!match) {
      throw new Error(`Couldn't find a public key line in ${defaultAgeKeyPath}`);
    }
    ctx.agePublicKey = match[1];

    const sopsYaml = await readFile(sopsYamlPath, "utf8");
    if (sopsYaml.includes(PLACEHOLDER)) {
      await writeFile(sopsYamlPath, sopsYaml.replaceAll(PLACEHOLDER, ctx.agePublicKey));
      task.output = `Wrote public key into ${sopsYamlPath}`;
    }

    task.title = `Age key ready (${ctx.agePublicKey.slice(0, 12)}…) — back it up outside this machine if you haven't yet`;
  },
};
