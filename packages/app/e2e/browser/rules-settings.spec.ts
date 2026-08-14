import { test, expect, type Page } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { expectSettingsHeader, openSettingsSection } from "../support/helpers/settings";
import { getServerId } from "../support/helpers/server-id";

// What a daemon writes into an empty rules directory, and the only rule a fresh
// home has. Asserting on it is asserting that the seed reached disk, that the
// daemon served it and that the app grouped it — the whole read path in one row.
const SEEDED_RULE_ID = "cold-prompt-cache";
// A plain warn with no outcome parameters to fill in, so the save exercises the
// upsert rather than the editor's parameter fields.
const EXAMPLE_ID = "warn-context-nearly-full";

const ROW_SELECTOR = '[data-testid^="pre-send-check-row-"]';

async function openRules(page: Page): Promise<void> {
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsSection(page, "rules");
  await expectSettingsHeader(page, "Rules");
}

async function listedRuleIds(page: Page): Promise<string[]> {
  return page
    .locator(ROW_SELECTOR)
    .evaluateAll((rows) =>
      rows.map((row) => (row.getAttribute("data-testid") ?? "").replace("pre-send-check-row-", "")),
    );
}

test.describe("Settings — Rules", () => {
  test("lists the seeded rule and the host switch that governs it", async ({ page }) => {
    await openRules(page);

    const row = page.getByTestId(`pre-send-check-row-${SEEDED_RULE_ID}`);
    await expect(row).toBeVisible();
    await expect(row.getByText("Block message", { exact: true })).toBeVisible();

    // Absent means on, so a host that has never been sent the switch still shows
    // it checked — which is the state a fresh daemon is in.
    const featureSwitch = page.getByTestId(`pre-send-checks-enabled-switch-${getServerId()}`);
    await expect(featureSwitch).toBeVisible();
    await expect(featureSwitch).toHaveAttribute("aria-checked", "true");
  });

  test("an example becomes a rule on the host, and can be taken off again", async ({ page }) => {
    await openRules(page);
    await expect(page.locator(ROW_SELECTOR)).toHaveCount(1);

    // An example opens the editor pre-filled rather than installing itself, so
    // the save below is the same path a hand-written rule takes.
    await page.getByTestId(`pre-send-check-example-add-${EXAMPLE_ID}`).click();
    await expect(page.getByTestId("pre-send-check-save")).toBeVisible();
    await page.getByTestId("pre-send-check-save").click();

    // The daemon pushes on change, so the new row arrives without a reload. Its
    // id is minted in the browser, which is what makes one rule on three hosts
    // one row — and why the test has to read it back rather than know it.
    await expect(page.locator(ROW_SELECTOR)).toHaveCount(2);
    const addedId = (await listedRuleIds(page)).find((id) => id !== SEEDED_RULE_ID);
    expect(addedId).toBeTruthy();

    const addedRow = page.getByTestId(`pre-send-check-row-${addedId}`);
    await expect(addedRow.getByText("Warn", { exact: true })).toBeVisible();

    // Removal confirms through the browser's own dialog on web.
    page.once("dialog", (dialog) => {
      void dialog.accept();
    });
    await page.getByTestId(`pre-send-check-remove-${addedId}`).click();

    await expect(page.locator(ROW_SELECTOR)).toHaveCount(1);
    await expect(page.getByTestId(`pre-send-check-row-${SEEDED_RULE_ID}`)).toBeVisible();
  });
});
