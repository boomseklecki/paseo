import { i18n } from "@/i18n/i18next";

export type AgentInputSubmitResult =
  | "noop"
  | "queued"
  | "submitted"
  | "blocked"
  | "redirected"
  | "failed";

export interface AgentInputSubmitActionInput<TAttachment> {
  message: string;
  attachments: TAttachment[];
  hasExternalContent?: boolean;
  allowEmptySubmit?: boolean;
  submitBehavior?: "clear" | "preserve-and-lock";
  forceSend?: boolean;
  isAgentRunning: boolean;
  canSubmit: boolean;
  queueMessage: (input: { message: string; attachments: TAttachment[] }) => void;
  /**
   * Consulted once the send is otherwise going ahead. Returning `"block"` stops
   * it before any state is touched, so the typed message and its attachments
   * stay exactly where the user left them.
   *
   * Synchronous by contract: an `await` between this decision and the clear
   * below would leave a window for another send to interleave.
   */
  runPreSendChecks?: (input: { message: string }) => Promise<"allow" | "block" | "redirected">;
  submitMessage: (input: { message: string; attachments: TAttachment[] }) => Promise<void>;
  clearDraft: (lifecycle: "sent" | "abandoned") => void;
  setUserInput: (text: string) => void;
  setAttachments: (attachments: TAttachment[]) => void;
  setSendError: (message: string | null) => void;
  setIsProcessing: (isProcessing: boolean) => void;
  onSubmitError?: (error: unknown) => void;
  failedToSendMessage?: string;
}

export async function submitAgentInput<TAttachment>(
  input: AgentInputSubmitActionInput<TAttachment>,
): Promise<AgentInputSubmitResult> {
  const trimmedMessage = input.message.trim();
  const attachments = input.attachments;
  const shouldClearOnSubmit = input.submitBehavior !== "preserve-and-lock";

  if (
    !trimmedMessage &&
    attachments.length === 0 &&
    !input.hasExternalContent &&
    !input.allowEmptySubmit
  ) {
    return "noop";
  }

  if (!input.canSubmit) {
    return "noop";
  }

  if (input.isAgentRunning && !input.forceSend) {
    input.queueMessage({ message: trimmedMessage, attachments });
    if (shouldClearOnSubmit) {
      input.setUserInput("");
      input.setAttachments([]);
    }
    return "queued";
  }

  // Deliberately after the queue branch: a running agent means the provider-side
  // cache is warm by definition, so gating a queued message would be pure noise.
  // Deliberately before the clear: returning here has to leave the composer
  // untouched, and the only way to guarantee that is to have touched nothing yet.
  const gate = (await input.runPreSendChecks?.({ message: trimmedMessage })) ?? "allow";
  if (gate === "block") {
    return "blocked";
  }
  // A redirect consumed the message: it went somewhere other than the agent, so
  // nothing is sent, but the box is cleared exactly as a successful send clears
  // it. Leaving the text would invite sending it a second time to the agent it
  // was deliberately kept away from.
  if (gate === "redirected") {
    if (shouldClearOnSubmit) {
      input.setUserInput("");
      input.setAttachments([]);
    }
    return "redirected";
  }

  // Clear immediately so the submitted timeline row and composer state stay in sync.
  if (shouldClearOnSubmit) {
    input.setUserInput("");
    input.setAttachments([]);
  }
  input.setSendError(null);
  input.setIsProcessing(true);

  try {
    await input.submitMessage({ message: trimmedMessage, attachments });
    input.clearDraft("sent");
    input.setIsProcessing(false);
    return "submitted";
  } catch (error) {
    input.onSubmitError?.(error);
    if (shouldClearOnSubmit) {
      input.setUserInput(trimmedMessage);
      input.setAttachments(attachments);
    }
    input.setSendError(
      error instanceof Error
        ? error.message
        : (input.failedToSendMessage ?? i18n.t("composer.errors.failedToSend")),
    );
    input.setIsProcessing(false);
    return "failed";
  }
}
