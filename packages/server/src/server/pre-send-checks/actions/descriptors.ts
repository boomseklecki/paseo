import type { PreSendActionDescriptor } from "@getpaseo/protocol/pre-send-checks/types";

/**
 * What this daemon can do, described well enough for an editor to draw it.
 *
 * Lives beside the action rather than in the app so that adding one is a server
 * change: the editor renders whatever arrives and needs no knowledge of the
 * kinds. That is the whole point of sending these — an older app offering a
 * newer daemon's action is what this buys.
 *
 * The strings are English and not translated. Provider feature labels already
 * work this way, and the alternative is that the daemon cannot describe anything
 * the app has not already shipped a translation for, which is the coupling this
 * exists to remove.
 */
export const PRE_SEND_ACTION_DESCRIPTORS: readonly PreSendActionDescriptor[] = [
  {
    kind: "aside",
    label: "Ask on the side",
    description:
      "Answers the message in a hidden agent and shows the reply under subagents. The conversation is not sent to and does not take a turn.",
    parameters: [
      {
        type: "text",
        id: "title",
        label: "Panel title",
        description: "What the subagent is called.",
        placeholder: "Aside",
      },
      {
        type: "text",
        id: "prompt",
        label: "Prompt",
        description: "Wraps the message. {{message}} is replaced with what you typed.",
        placeholder: "Answer this side question.\n\n{{message}}",
        multiline: true,
      },
    ],
  },
  {
    kind: "fork",
    label: "Fork the conversation",
    description:
      "Carries this conversation into a new one, up to where it had got to. The new agent is a real one in the same workspace, not hidden - Paseo has a button for this, and a rule is how you make it a shortcut.",
    parameters: [
      {
        type: "text",
        id: "title",
        label: "New conversation's name",
        description: "Defaults to the original's name with (fork) after it.",
      },
    ],
  },
  {
    kind: "start",
    label: "Start a fresh conversation",
    description:
      "Opens a new conversation beside this one, in the same workspace, carrying none of it. The right one when the rule fired because this conversation is full - a fork would carry in the very thing that triggered it.",
    parameters: [
      {
        type: "text",
        id: "title",
        label: "New conversation's name",
        description: "Defaults to the original's name with (continued) after it.",
      },
      {
        type: "text",
        id: "prompt",
        label: "Opening message",
        description:
          "Optional. Sent to the new conversation as its first message. {{message}} is replaced with what you typed. Leave empty to open it and leave it waiting.",
        multiline: true,
      },
    ],
  },
];
