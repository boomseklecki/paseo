import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

import { z } from "zod";
import { PersistedConfigSchema } from "../src/server/persisted-config.js";
import { PreSendCheckRuleSchema } from "@getpaseo/protocol/pre-send-checks/types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function write(schemaDir: string, fileName: string, schema: z.core.JSONSchema.BaseSchema): void {
  const outPath = path.join(schemaDir, fileName);
  fs.writeFileSync(outPath, JSON.stringify(schema, null, 2) + "\n", "utf8");
  process.stdout.write(`Wrote ${outPath}\n`);
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
  write(schemaDir, "paseo.config.v1.json", config);

  // One rule file under <PASEO_HOME>/pre-send-checks/. Worth publishing because
  // hand-editing is the only way to author these until a settings screen lands,
  // and because a malformed rule is now skipped with a line in the daemon log
  // rather than refused loudly - editor-side validation is what puts the noticing
  // back where the author can act on it.
  const rule = z.toJSONSchema(PreSendCheckRuleSchema, {
    target: "draft-07",
    unrepresentable: "any",
    io: "input",
  });
  rule.title = "PaseoPreSendCheckV1";
  write(schemaDir, "paseo.pre-send-check.v1.json", rule);
}

main();
