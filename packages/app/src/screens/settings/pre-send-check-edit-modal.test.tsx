import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreSendCheckEditModal, type PreSendCheckModalHost } from "./pre-send-check-edit-modal";
import type { PreSendCheckDraft } from "./pre-send-check-form";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 2: 8, 3: 12, 4: 16, 6: 24 },
    fontSize: { sm: 13, base: 15, xs: 11 },
    fontWeight: { medium: 500 },
    borderRadius: { md: 6, lg: 8, xl: 12 },
    borderWidth: { 1: 1 },
    opacity: { 50: 0.5 },
    colors: {
      surface2: "#222",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#555",
      accent: "#0a84ff",
      borderAccent: "#555",
      palette: { red: { 300: "#f87171" } },
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
  // Reached through the host switches, which pull in `Switch`. The real one
  // injects themed props; here the component is enough, since nothing in this
  // file asserts on a colour.
  withUnistyles: (component: unknown) => component,
}));

vi.mock("@/constants/platform", () => ({ isWeb: true, isNative: false }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // Interpolation matters for one assertion — the unrecognised-value label has
    // to carry the value through, or the picker cannot show what it is holding.
    t: (key: string, options?: Record<string, unknown>) =>
      options && "value" in options ? `${key}:${String(options.value)}` : key,
  }),
}));

const inputPropsByTestID = vi.hoisted(() => ({
  map: new Map<string, { onChangeText?: (next: string) => void; onSubmitEditing?: () => void }>(),
}));

const selectPropsByTestID = vi.hoisted(() => ({
  map: new Map<string, { onChange?: (next: string) => void; options: string[]; value: string }>(),
}));

vi.mock("@/components/adaptive-modal-sheet", async () => {
  const ReactModule = await import("react");
  const AdaptiveModalSheet = ({
    visible,
    header,
    children,
    onClose,
    testID,
  }: {
    visible: boolean;
    header: { title: string };
    children: React.ReactNode;
    onClose: () => void;
    testID?: string;
  }) => {
    if (!visible) return null;
    return ReactModule.createElement(
      "div",
      { "data-testid": testID ?? "sheet", "data-modal-title": header?.title },
      ReactModule.createElement(
        "button",
        { type: "button", "data-testid": "sheet-close", onClick: onClose },
        "Close",
      ),
      children,
    );
  };
  const AdaptiveTextInput = ReactModule.forwardRef<HTMLInputElement, Record<string, unknown>>(
    (props, ref) => {
      const p = props as {
        initialValue?: string;
        editable?: boolean;
        testID?: string;
        onChangeText?: (next: string) => void;
        onSubmitEditing?: () => void;
      };
      if (p.testID) {
        inputPropsByTestID.map.set(p.testID, {
          onChangeText: p.onChangeText,
          onSubmitEditing: p.onSubmitEditing,
        });
      }
      return ReactModule.createElement("input", {
        ref,
        defaultValue: p.initialValue ?? "",
        disabled: p.editable === false,
        "data-testid": p.testID,
        onChange: (e: { target: { value: string } }) => p.onChangeText?.(e.target.value),
      });
    },
  );
  return { AdaptiveModalSheet, AdaptiveTextInput };
});

// SelectField is a combobox with a portal and a sheet on mobile; none of that is
// what this file is testing. The mock keeps the two things the modal depends on:
// which options were offered, and that choosing one reports the value.
vi.mock("@/components/ui/select-field", async () => {
  const ReactModule = await import("react");
  return {
    SelectField: ({
      value,
      options,
      onChange,
      disabled,
      testID,
    }: {
      value: string;
      options: { value: string; label: string }[];
      onChange: (next: string) => void;
      disabled?: boolean;
      testID?: string;
    }) => {
      if (testID) {
        selectPropsByTestID.map.set(testID, {
          onChange,
          options: options.map((option) => option.value),
          value,
        });
      }
      return ReactModule.createElement("div", {
        "data-testid": testID,
        "data-value": value,
        "data-disabled": disabled ? "true" : "false",
        "data-options": options.map((option) => option.label).join("|"),
      });
    },
  };
});

// The real switch animates its track colour through reanimated, which needs a
// theme this file does not stand up. A checkbox reports the same two things.
vi.mock("@/components/ui/switch", async () => {
  const ReactModule = await import("react");
  return {
    Switch: ({
      value,
      onValueChange,
      disabled,
      testID,
    }: {
      value: boolean;
      onValueChange: (next: boolean) => void;
      disabled?: boolean;
      testID?: string;
    }) =>
      ReactModule.createElement("input", {
        type: "checkbox",
        checked: value,
        disabled,
        "data-testid": testID,
        onChange: () => onValueChange(!value),
      }),
  };
});

vi.mock("@/components/ui/button", async () => {
  const ReactModule = await import("react");
  return {
    Button: ({
      children,
      onPress,
      disabled,
      testID,
    }: {
      children?: React.ReactNode;
      onPress?: () => void;
      disabled?: boolean;
      testID?: string;
    }) =>
      ReactModule.createElement(
        "button",
        {
          type: "button",
          "data-testid": testID,
          disabled: disabled || undefined,
          onClick: () => !disabled && onPress?.(),
        },
        children,
      ),
  };
});

let root: Root | null = null;
let container: HTMLElement | null = null;

const DRAFT: PreSendCheckDraft = {
  measurement: "agent.idleSeconds",
  operator: "gte",
  threshold: "3600",
  disposition: "block",
  message: "",
  actionKind: "",
  actionParams: {},
};

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("HTMLInputElement", dom.window.HTMLInputElement);
  vi.stubGlobal("KeyboardEvent", dom.window.KeyboardEvent);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);

  inputPropsByTestID.map.clear();
  selectPropsByTestID.map.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(() => {});
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

const ONE_HOST: PreSendCheckModalHost[] = [{ serverId: "a", serverName: "Alpha", isUsable: true }];

const TWO_HOSTS: PreSendCheckModalHost[] = [
  ...ONE_HOST,
  { serverId: "b", serverName: "Bravo", isUsable: true },
];

interface RenderOptions {
  visible?: boolean;
  initialDraft?: PreSendCheckDraft;
  hosts?: PreSendCheckModalHost[];
  initialServerIds?: string[];
  onClose?: () => void;
  onSave?: (draft: PreSendCheckDraft, serverIds: readonly string[]) => Promise<void>;
}

function renderModal(options: RenderOptions = {}) {
  const {
    visible = true,
    initialDraft = DRAFT,
    hosts = ONE_HOST,
    initialServerIds = hosts.map((host) => host.serverId),
    onClose = vi.fn(),
    onSave = vi.fn().mockResolvedValue(undefined),
  } = options;
  act(() => {
    root?.render(
      <PreSendCheckEditModal
        visible={visible}
        title="Edit rule"
        initialDraft={initialDraft}
        hosts={hosts}
        actions={[]}
        initialServerIds={initialServerIds}
        onClose={onClose}
        onSave={onSave}
        testID="psc"
      />,
    );
  });
  return { onClose, onSave };
}

const query = (testID: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${testID}"]`) ?? null;

function click(element: Element | null): void {
  if (!element) throw new Error("Cannot click null element");
  act(() => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
}

function typeInto(testID: string, value: string): void {
  act(() => {
    inputPropsByTestID.map.get(testID)?.onChangeText?.(value);
  });
}

function choose(testID: string, value: string): void {
  act(() => {
    selectPropsByTestID.map.get(testID)?.onChange?.(value);
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("PreSendCheckEditModal", () => {
  it("renders the initial draft pre-filled", () => {
    renderModal({ initialDraft: { ...DRAFT, message: "mine" } });

    expect(query("psc-threshold-input")).toHaveProperty("value", "3600");
    expect(query("psc-message-input")).toHaveProperty("value", "mine");
    expect(query("psc-measurement-select")?.getAttribute("data-value")).toBe("agent.idleSeconds");
    expect(query("psc-disposition-select")?.getAttribute("data-value")).toBe("block");
  });

  it("saves the edited draft and closes", async () => {
    const { onSave, onClose } = renderModal();

    typeInto("psc-threshold-input", "60");
    choose("psc-disposition-select", "warn");
    typeInto("psc-message-input", "cold cache");
    click(query("pre-send-check-save"));
    await flush();

    expect(onSave).toHaveBeenCalledWith(
      {
        ...DRAFT,
        threshold: "60",
        disposition: "warn",
        message: "cold cache",
      },
      ["a"],
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("blocks a save with an unusable threshold and says which field", async () => {
    const { onSave } = renderModal();

    typeInto("psc-threshold-input", "soon");
    click(query("pre-send-check-save"));
    await flush();

    expect(onSave).not.toHaveBeenCalled();
    expect(query("psc-threshold-error")?.textContent).toContain("thresholdInvalid");
  });

  it("clears a field error once that field is edited", async () => {
    renderModal();

    typeInto("psc-threshold-input", "");
    click(query("pre-send-check-save"));
    await flush();
    expect(query("psc-threshold-error")).not.toBeNull();

    typeInto("psc-threshold-input", "60");
    expect(query("psc-threshold-error")).toBeNull();
  });

  it("disables save and cancel while a save is in flight", async () => {
    let resolveSave: (() => void) | undefined;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    renderModal({ onSave });

    click(query("pre-send-check-save"));
    await flush();

    expect(query("pre-send-check-save")?.hasAttribute("disabled")).toBe(true);
    expect(query("pre-send-check-cancel")?.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      resolveSave?.();
    });
  });

  // A failed save has to leave the form standing with what was typed in it, for
  // the same reason a blocked send leaves the composer alone.
  it("stays open and reports the reason when a save is refused", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("disk full"));
    const { onClose } = renderModal({ onSave });

    click(query("pre-send-check-save"));
    await flush();

    expect(query("pre-send-check-submit-error")?.textContent).toBe("disk full");
    expect(onClose).not.toHaveBeenCalled();
    expect(query("psc-threshold-input")).toHaveProperty("value", "3600");
    expect(query("pre-send-check-save")?.hasAttribute("disabled")).toBe(false);
  });

  it("cancels without saving", () => {
    const { onSave, onClose } = renderModal();

    click(query("pre-send-check-cancel"));

    expect(onClose).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  // The near side of the guarantee the wire schema gives by keeping these fields
  // plain strings: a picker must be able to represent, and hand back, a value this
  // build does not know.
  it("offers an unrecognised operator and saves it unchanged", async () => {
    const { onSave } = renderModal({ initialDraft: { ...DRAFT, operator: "approaches" } });

    const select = selectPropsByTestID.map.get("psc-operator-select");
    expect(select?.options).toContain("approaches");
    expect(query("psc-operator-select")?.getAttribute("data-value")).toBe("approaches");
    expect(query("psc-operator-select")?.getAttribute("data-options")).toContain("approaches");

    click(query("pre-send-check-save"));
    await flush();

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ operator: "approaches" }),
      expect.anything(),
    );
  });

  it("swaps the threshold hint when the measurement changes", () => {
    renderModal();
    expect(query("psc-threshold-hint")?.textContent).toContain("thresholdUnits.idleSeconds");

    choose("psc-measurement-select", "agent.sessionCostUsd");

    expect(query("psc-threshold-hint")?.textContent).toContain("thresholdUnits.sessionCostUsd");
  });

  // A single-daemon setup must not be shown a choice it does not have, and there
  // is exactly one place its rule can go.
  it("hides the host field when there is only one host", () => {
    renderModal();
    expect(query("psc-hosts")).toBeNull();
  });

  it("offers a switch per host when there are several", () => {
    renderModal({ hosts: TWO_HOSTS });
    expect(query("psc-hosts")).not.toBeNull();
    expect(query("pre-send-check-host-a")).not.toBeNull();
    expect(query("pre-send-check-host-b")).not.toBeNull();
  });

  // Saving with nothing selected would delete the rule from every host it was on,
  // which is not what a save button says it does.
  it("refuses to save a rule assigned to no host", async () => {
    const { onSave } = renderModal({ hosts: TWO_HOSTS, initialServerIds: [] });

    click(query("pre-send-check-save"));
    await flush();

    expect(onSave).not.toHaveBeenCalled();
    expect(query("pre-send-check-submit-error")?.textContent).toContain("hostsRequired");
  });

  it("saves to the hosts left switched on", async () => {
    const { onSave } = renderModal({ hosts: TWO_HOSTS });

    click(query("pre-send-check-host-a"));
    click(query("pre-send-check-save"));
    await flush();

    expect(onSave).toHaveBeenCalledWith(expect.anything(), ["b"]);
  });

  it("passes the assigned hosts to the save", async () => {
    const { onSave } = renderModal({ hosts: TWO_HOSTS, initialServerIds: ["b"] });

    click(query("pre-send-check-save"));
    await flush();

    expect(onSave).toHaveBeenCalledWith(expect.anything(), ["b"]);
  });
});
