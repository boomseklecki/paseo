import { z } from "zod";
import { PreSendCheckRuleSchema } from "./types.js";

/**
 * Upsert rather than create-plus-update, for three reasons. The store's `write`
 * already is an upsert. It is one verb instead of two. And the id comes from the
 * caller, which is what will let the same rule exist on several daemons under one
 * id once rules become assignable to more than one host — a create verb that
 * minted its own id would have to be replaced then.
 *
 * Both writes echo the whole resulting list rather than the one rule, so a client
 * replaces its cache from the response instead of merging into it.
 * `pre_send_checks_changed` follows moments later carrying the same content and
 * is idempotent against it.
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

export const PreSendChecksUpsertRequestSchema = z.object({
  type: z.literal("pre_send_checks/upsert"),
  requestId: z.string(),
  check: PreSendCheckRuleSchema,
});

export const PreSendChecksUpsertResponseSchema = z.object({
  type: z.literal("pre_send_checks/upsert/response"),
  payload: z.object({
    requestId: z.string(),
    checks: z.array(PreSendCheckRuleSchema),
    error: z.string().nullable(),
  }),
});

/**
 * Takes the whole ordered id list rather than a pair to swap.
 *
 * Two upserts would be two writes, two broadcasts, and a window between them
 * where two rules claim the same position. One verb rewrites every order in a
 * single pass, so the arrangement is never half-applied. Ids the daemon does not
 * have are ignored, and rules the list omits keep whatever order they had.
 */
export const PreSendChecksReorderRequestSchema = z.object({
  type: z.literal("pre_send_checks/reorder"),
  requestId: z.string(),
  ruleIds: z.array(z.string()),
});

export const PreSendChecksReorderResponseSchema = z.object({
  type: z.literal("pre_send_checks/reorder/response"),
  payload: z.object({
    requestId: z.string(),
    checks: z.array(PreSendCheckRuleSchema),
    error: z.string().nullable(),
  }),
});

/**
 * Carries out a rule's action instead of sending the message.
 *
 * The action travels with the request rather than being looked up by rule id,
 * because the client has already evaluated the rules and the daemon re-reading
 * them could disagree with what the client acted on: rules can change between
 * the send and this call, and the message must not be consumed by a different
 * action than the one that claimed it.
 *
 * `confirmed` is the second half of a two-step. The daemon answers
 * `needs_confirmation` when the action would cost more than the caller is likely
 * to expect, and the caller asks again with this set once the person agrees.
 */
export const PreSendChecksRunActionRequestSchema = z.object({
  type: z.literal("pre_send_checks/run_action"),
  requestId: z.string(),
  agentId: z.string(),
  message: z.string(),
  action: z.object({ kind: z.string() }).passthrough(),
  confirmed: z.boolean().optional(),
});

/**
 * `declined` is not an error and must not be rendered as one: it means the
 * daemon did not consume the message, so the caller should send it the ordinary
 * way. `failed` is the opposite instruction — the action was the right one and
 * broke — and sending the text on anyway would deliver the aside to the agent as
 * an instruction.
 */
export const PreSendChecksRunActionResponseSchema = z.object({
  type: z.literal("pre_send_checks/run_action/response"),
  payload: z.object({
    requestId: z.string(),
    status: z.enum(["started", "needs_confirmation", "declined", "failed"]),
    subagentId: z.string().nullable(),
    reason: z.string().nullable(),
    estimatedTokens: z.number().nullable(),
  }),
});

export const PreSendChecksDeleteRequestSchema = z.object({
  type: z.literal("pre_send_checks/delete"),
  requestId: z.string(),
  ruleId: z.string(),
});

export const PreSendChecksDeleteResponseSchema = z.object({
  type: z.literal("pre_send_checks/delete/response"),
  payload: z.object({
    requestId: z.string(),
    checks: z.array(PreSendCheckRuleSchema),
    error: z.string().nullable(),
  }),
});
