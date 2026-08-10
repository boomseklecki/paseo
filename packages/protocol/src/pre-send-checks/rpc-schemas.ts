import { z } from "zod";
import { PreSendCheckRuleSchema } from "./types.js";

/**
 * Read-only for now. Rules are authored by hand in
 * `<PASEO_HOME>/pre-send-checks/`, and the daemon re-reads that directory rather
 * than caching it, so there is nothing a write verb would do this pass that
 * editing a file does not. Create/update/delete land with the settings UI.
 */

export const PreSendChecksListRequestSchema = z.object({
  type: z.literal("pre_send_checks/list"),
  requestId: z.string(),
});

export const PreSendChecksListResponseSchema = z.object({
  type: z.literal("pre_send_checks/list/response"),
  payload: z.object({
    requestId: z.string(),
    // Always concrete, never absent — an empty array means the user turned every
    // rule off, and the client relies on being able to tell that apart from not
    // having loaded yet.
    checks: z.array(PreSendCheckRuleSchema),
    error: z.string().nullable(),
  }),
});
