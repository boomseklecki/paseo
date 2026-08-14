import { describe, expect, it, vi } from "vitest";
import { submitAgentInput } from "./submit";

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return {
    promise,
    resolve,
    reject,
  };
}

describe("submitAgentInput", () => {
  it("clears the composer before an in-flight submit resolves", async () => {
    const deferred = createDeferredPromise<void>();
    const queueMessage = vi.fn();
    const submitMessage = vi.fn(async () => {
      await deferred.promise;
    });
    const clearDraft = vi.fn();
    const setUserInput = vi.fn();
    const setAttachments = vi.fn();
    const setSendError = vi.fn();
    const setIsProcessing = vi.fn();

    const submitPromise = submitAgentInput({
      message: "  hello world  ",
      attachments: [],
      isAgentRunning: false,
      canSubmit: true,
      queueMessage,
      submitMessage,
      clearDraft,
      setUserInput,
      setAttachments,
      setSendError,
      setIsProcessing,
    });

    // The rule gate is awaited, so the submit starts a microtask after the
    // call rather than inside it. This yields once so the assertions below are
    // about the in-flight state rather than about scheduling.
    await Promise.resolve();
    expect(queueMessage).not.toHaveBeenCalled();
    expect(submitMessage).toHaveBeenCalledWith({
      message: "hello world",
      attachments: [],
    });
    expect(setUserInput).toHaveBeenCalledWith("");
    expect(setAttachments).toHaveBeenCalledWith([]);
    expect(setSendError).toHaveBeenCalledWith(null);
    expect(setIsProcessing).toHaveBeenCalledWith(true);
    expect(clearDraft).not.toHaveBeenCalled();

    deferred.resolve();

    await expect(submitPromise).resolves.toBe("submitted");
    expect(clearDraft).toHaveBeenCalledWith("sent");
  });

  it("preserves the composer before an in-flight submit resolves when requested", async () => {
    const deferred = createDeferredPromise<void>();
    const attachments = [{ id: "img-1" }];
    const queueMessage = vi.fn();
    const submitMessage = vi.fn(async () => {
      await deferred.promise;
    });
    const clearDraft = vi.fn();
    const setUserInput = vi.fn();
    const setAttachments = vi.fn();
    const setSendError = vi.fn();
    const setIsProcessing = vi.fn();

    const submitPromise = submitAgentInput({
      message: "  keep me  ",
      attachments,
      submitBehavior: "preserve-and-lock",
      isAgentRunning: false,
      canSubmit: true,
      queueMessage,
      submitMessage,
      clearDraft,
      setUserInput,
      setAttachments,
      setSendError,
      setIsProcessing,
    });

    // The rule gate is awaited, so the submit starts a microtask after the
    // call rather than inside it. This yields once so the assertions below are
    // about the in-flight state rather than about scheduling.
    await Promise.resolve();
    expect(queueMessage).not.toHaveBeenCalled();
    expect(submitMessage).toHaveBeenCalledWith({
      message: "keep me",
      attachments,
    });
    expect(setUserInput).not.toHaveBeenCalled();
    expect(setAttachments).not.toHaveBeenCalled();
    expect(setSendError).toHaveBeenCalledWith(null);
    expect(setIsProcessing).toHaveBeenCalledWith(true);
    expect(clearDraft).not.toHaveBeenCalled();

    deferred.resolve();

    await expect(submitPromise).resolves.toBe("submitted");
    expect(clearDraft).toHaveBeenCalledWith("sent");
  });

  it("queues while the agent is running and clears the composer immediately", async () => {
    const queueMessage = vi.fn();
    const submitMessage = vi.fn();
    const clearDraft = vi.fn();
    const setUserInput = vi.fn();
    const setAttachments = vi.fn();
    const setSendError = vi.fn();
    const setIsProcessing = vi.fn();

    await expect(
      submitAgentInput({
        message: "  queued message  ",
        attachments: [{ id: "img-1" }],
        isAgentRunning: true,
        canSubmit: true,
        queueMessage,
        submitMessage,
        clearDraft,
        setUserInput,
        setAttachments,
        setSendError,
        setIsProcessing,
      }),
    ).resolves.toBe("queued");

    expect(queueMessage).toHaveBeenCalledWith({
      message: "queued message",
      attachments: [{ id: "img-1" }],
    });
    expect(submitMessage).not.toHaveBeenCalled();
    expect(setUserInput).toHaveBeenCalledWith("");
    expect(setAttachments).toHaveBeenCalledWith([]);
    expect(setSendError).not.toHaveBeenCalled();
    expect(setIsProcessing).not.toHaveBeenCalled();
    expect(clearDraft).not.toHaveBeenCalled();
  });

  it("restores the composer when submit fails", async () => {
    const submitError = new Error("No host selected");
    const queueMessage = vi.fn();
    const submitMessage = vi.fn(async () => {
      throw submitError;
    });
    const clearDraft = vi.fn();
    const setUserInput = vi.fn();
    const setAttachments = vi.fn();
    const setSendError = vi.fn();
    const setIsProcessing = vi.fn();
    const onSubmitError = vi.fn();
    const attachments = [{ id: "img-1" }];

    await expect(
      submitAgentInput({
        message: "  hello world  ",
        attachments,
        isAgentRunning: false,
        canSubmit: true,
        queueMessage,
        submitMessage,
        clearDraft,
        setUserInput,
        setAttachments,
        setSendError,
        setIsProcessing,
        onSubmitError,
      }),
    ).resolves.toBe("failed");

    expect(onSubmitError).toHaveBeenCalledWith(submitError);
    expect(setUserInput).toHaveBeenNthCalledWith(1, "");
    expect(setUserInput).toHaveBeenNthCalledWith(2, "hello world");
    expect(setAttachments).toHaveBeenNthCalledWith(1, []);
    expect(setAttachments).toHaveBeenNthCalledWith(2, attachments);
    expect(setSendError).toHaveBeenNthCalledWith(1, null);
    expect(setSendError).toHaveBeenNthCalledWith(2, "No host selected");
    expect(setIsProcessing).toHaveBeenNthCalledWith(1, true);
    expect(setIsProcessing).toHaveBeenNthCalledWith(2, false);
    expect(clearDraft).not.toHaveBeenCalled();
  });

  // The whole point of the gate is that a blocked send costs the user nothing.
  // Asserting on every setter individually is what "the text is still there" means
  // in this function, since it owns no state of its own.
  it("touches nothing when a rule blocks", async () => {
    const queueMessage = vi.fn();
    const submitMessage = vi.fn(async () => {});
    const clearDraft = vi.fn();
    const setUserInput = vi.fn();
    const setAttachments = vi.fn();
    const setSendError = vi.fn();
    const setIsProcessing = vi.fn();
    const runRules = vi.fn(async () => "block" as const);
    const attachments = [{ id: "img-1" }];

    await expect(
      submitAgentInput({
        message: "  hello world  ",
        attachments,
        isAgentRunning: false,
        canSubmit: true,
        queueMessage,
        submitMessage,
        clearDraft,
        setUserInput,
        setAttachments,
        setSendError,
        setIsProcessing,
        runRules,
      }),
    ).resolves.toBe("blocked");

    expect(runRules).toHaveBeenCalledWith({ message: "hello world" });
    expect(submitMessage).not.toHaveBeenCalled();
    expect(queueMessage).not.toHaveBeenCalled();
    expect(setUserInput).not.toHaveBeenCalled();
    expect(setAttachments).not.toHaveBeenCalled();
    expect(setSendError).not.toHaveBeenCalled();
    expect(setIsProcessing).not.toHaveBeenCalled();
    expect(clearDraft).not.toHaveBeenCalled();
  });

  it("submits normally when a rule allows", async () => {
    const queueMessage = vi.fn();
    const submitMessage = vi.fn(async () => {});
    const clearDraft = vi.fn();
    const setUserInput = vi.fn();
    const setAttachments = vi.fn();
    const setSendError = vi.fn();
    const setIsProcessing = vi.fn();
    const runRules = vi.fn(async () => "allow" as const);

    await expect(
      submitAgentInput({
        message: "  hello world  ",
        attachments: [],
        isAgentRunning: false,
        canSubmit: true,
        queueMessage,
        submitMessage,
        clearDraft,
        setUserInput,
        setAttachments,
        setSendError,
        setIsProcessing,
        runRules,
      }),
    ).resolves.toBe("submitted");

    expect(submitMessage).toHaveBeenCalledWith({
      message: "hello world",
      attachments: [],
    });
    expect(setUserInput).toHaveBeenCalledWith("");
    expect(clearDraft).toHaveBeenCalledWith("sent");
  });

  // A redirect took the message somewhere other than the agent. Nothing is sent,
  // but the box clears as a successful send would: leaving the text there invites
  // sending it a second time to the agent it was deliberately kept away from.
  it("clears the composer when a rule redirected the message", async () => {
    const queueMessage = vi.fn();
    const submitMessage = vi.fn();
    const clearDraft = vi.fn();
    const setUserInput = vi.fn();
    const setAttachments = vi.fn();
    const setSendError = vi.fn();
    const setIsProcessing = vi.fn();
    const runRules = vi.fn(async () => "redirected" as const);

    await expect(
      submitAgentInput({
        message: "/btw what was that flag",
        attachments: [],
        isAgentRunning: false,
        canSubmit: true,
        queueMessage,
        submitMessage,
        clearDraft,
        setUserInput,
        setAttachments,
        setSendError,
        setIsProcessing,
        runRules,
      }),
    ).resolves.toBe("redirected");

    expect(submitMessage).not.toHaveBeenCalled();
    expect(setUserInput).toHaveBeenCalledWith("");
    expect(setAttachments).toHaveBeenCalledWith([]);
  });

  // A running agent has a warm cache, so gating a queued message would be noise.
  // This pins the ordering rather than the outcome.
  it("does not consult rules for a queued message", async () => {
    const queueMessage = vi.fn();
    const submitMessage = vi.fn();
    const clearDraft = vi.fn();
    const setUserInput = vi.fn();
    const setAttachments = vi.fn();
    const setSendError = vi.fn();
    const setIsProcessing = vi.fn();
    const runRules = vi.fn(async () => "block" as const);

    await expect(
      submitAgentInput({
        message: "queued message",
        attachments: [],
        isAgentRunning: true,
        canSubmit: true,
        queueMessage,
        submitMessage,
        clearDraft,
        setUserInput,
        setAttachments,
        setSendError,
        setIsProcessing,
        runRules,
      }),
    ).resolves.toBe("queued");

    expect(runRules).not.toHaveBeenCalled();
    expect(queueMessage).toHaveBeenCalled();
  });

  it("does not consult rules for a send that was going to be a noop", async () => {
    const runRules = vi.fn(async () => "block" as const);

    await expect(
      submitAgentInput({
        message: "   ",
        attachments: [],
        isAgentRunning: false,
        canSubmit: true,
        queueMessage: vi.fn(),
        submitMessage: vi.fn(async () => {}),
        clearDraft: vi.fn(),
        setUserInput: vi.fn(),
        setAttachments: vi.fn(),
        setSendError: vi.fn(),
        setIsProcessing: vi.fn(),
        runRules,
      }),
    ).resolves.toBe("noop");

    expect(runRules).not.toHaveBeenCalled();
  });

  it("submits when empty submit is explicitly allowed", async () => {
    const queueMessage = vi.fn();
    const submitMessage = vi.fn(async () => {});
    const clearDraft = vi.fn();
    const setUserInput = vi.fn();
    const setAttachments = vi.fn();
    const setSendError = vi.fn();
    const setIsProcessing = vi.fn();

    await expect(
      submitAgentInput({
        message: "   ",
        attachments: [],
        allowEmptySubmit: true,
        isAgentRunning: false,
        canSubmit: true,
        queueMessage,
        submitMessage,
        clearDraft,
        setUserInput,
        setAttachments,
        setSendError,
        setIsProcessing,
      }),
    ).resolves.toBe("submitted");

    // The rule gate is awaited, so the submit starts a microtask after the
    // call rather than inside it. This yields once so the assertions below are
    // about the in-flight state rather than about scheduling.
    await Promise.resolve();
    expect(queueMessage).not.toHaveBeenCalled();
    expect(submitMessage).toHaveBeenCalledWith({
      message: "",
      attachments: [],
    });
    expect(clearDraft).toHaveBeenCalledWith("sent");
  });
});
