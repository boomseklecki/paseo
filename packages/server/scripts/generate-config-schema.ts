import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

import { z } from "zod";
import { PersistedConfigSchema } from "../src/server/persisted-config.js";
import { RuleSchema } from "@getpaseo/protocol/rules/types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function write(schemaDir: string, fileName: string, schema: z.core.JSONSchema.BaseSchema): string {
  const outPath = path.join(schemaDir, fileName);
  fs.writeFileSync(outPath, JSON.stringify(schema, null, 2) + "\n", "utf8");
  process.stdout.write(`Wrote ${outPath}\n`);
  return outPath;
}

/**
 * The formatter has the last word on what these files look like.
 *
 * `JSON.stringify` with an indent expands every array, and oxfmt keeps a short
 * one on a line, so the generator's own output does not pass `format:check`.
 * The two disagree on nothing but whitespace, but the pre-commit gate does not
 * know that: whoever regenerates next is stopped by a formatting failure in a
 * file they did not write by hand and cannot obviously fix.
 */
function format(repoRoot: string, paths: string[]): void {
  execFileSync(path.join(repoRoot, "node_modules/.bin/oxfmt"), paths, { stdio: "inherit" });
}

function main() {
  const repoRoot = path.resolve(__dirname, "../../..");
  const schemaDir = path.join(repoRoot, "packages/website/public/schemas");
  fs.mkdirSync(schemaDir, { recursive: true });

  const config = z.toJSONSchema(PersistedConfigSchema, {
    target: "draft-07",
    unrepresentable: "any",
    io: "input",
  });
  config.title = "PaseoConfigV1";
  const configPath = write(schemaDir, "paseo.config.v1.json", config);

  // One rule file under <PASEO_HOME>/rules/. Worth publishing because
  // hand-editing is the only way to author these until a settings screen lands,
  // and because a malformed rule is now skipped with a line in the daemon log
  // rather than refused loudly - editor-side validation is what puts the noticing
  // back where the author can act on it.
  const rule = z.toJSONSchema(RuleSchema, {
    target: "draft-07",
    unrepresentable: "any",
    io: "input",
  });
  rule.title = "PaseoRuleV1";
  const rulePath = write(schemaDir, "paseo.rule.v1.json", rule);

  format(repoRoot, [configPath, rulePath]);
}

main();
