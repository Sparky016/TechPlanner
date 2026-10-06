import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  createSession,
  login,
  publishPanel,
  resetAll,
  section,
  sectionEditor,
  waitForTurnEnd,
} from './support/helpers';

// Task 42 (NFR-10): automated WCAG 2.1 AA checks on every screen and a keyboard-only flow.

test.beforeEach(async ({ request }) => {
  await resetAll(request);
});

/** Fails on serious or critical axe violations, listing each with the offending selectors. */
async function expectNoSeriousViolations(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const summary = serious.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

/** Presses Tab until `target` holds focus (no mouse); fails if it is not reachable within `max` presses. */
async function tabTo(page: Page, target: Locator, max = 300): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('Element not reachable by keyboard');
}

test('AC1: no serious or critical axe violations on login, sessions, new session, workspace, override dialog, history drawer and audit pages', async ({
  page,
}) => {
  await page.goto('/login');
  await expectNoSeriousViolations(page, 'login');

  await login(page);
  await expectNoSeriousViolations(page, 'sessions list (empty)');

  const sessionId = await createSession(page, 'ABC-123');
  await page.goto('/sessions');
  await expect(page.getByRole('link', { name: /ABC-123/ }).first()).toBeVisible();
  await expectNoSeriousViolations(page, 'sessions list');

  await page.goto('/sessions/new');
  await expect(page.getByLabel('Jira ticket keys')).toBeVisible();
  await expectNoSeriousViolations(page, 'new session');

  await page.goto(`/sessions/${sessionId}`);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByRole('region', { name: 'Readiness', exact: true })).toBeVisible();
  await expectNoSeriousViolations(page, 'workspace');

  await page.getByRole('button', { name: 'History' }).click();
  await expect(page.getByRole('complementary', { name: 'Version history' })).toBeVisible();
  await expectNoSeriousViolations(page, 'workspace with history drawer');

  await publishPanel(page).getByRole('button', { name: 'Publish', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Publish with override' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expectNoSeriousViolations(page, 'override dialog');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await page.goto(`/sessions/${sessionId}/audit`);
  await expect(page.getByRole('row').first()).toBeVisible();
  await expectNoSeriousViolations(page, 'audit');
});

test('AC2 and AC3: keyboard-only flow; the override dialog traps focus and returns it to Publish', async ({ page }) => {
  await login(page);

  // Create a session.
  await page.goto('/sessions/new');
  const keys = page.getByLabel('Jira ticket keys');
  await tabTo(page, keys);
  await page.keyboard.type('ABC-123');
  await tabTo(page, page.getByRole('button', { name: 'Create session' }));
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/sessions\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(message).toBeEnabled({ timeout: 30_000 });

  // Send a message.
  await tabTo(page, message);
  await page.keyboard.type('Summarise the goal. #stream');
  await tabTo(page, page.getByRole('button', { name: 'Send' }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'AI is responding…' })).toBeVisible();
  await waitForTurnEnd(page);

  // Edit a section; autosave confirms.
  const editor = sectionEditor(page, 'Scope');
  await tabTo(page, editor);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Keyboard scope: CSV export.');
  await expect(section(page, 'Scope').getByText('Saved', { exact: true })).toBeVisible({ timeout: 15_000 });

  // Save draft.
  await tabTo(page, page.getByRole('button', { name: 'Save Draft' }));
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Draft saved as revision \d+/)).toBeVisible();

  // Open the override dialog from the keyboard; focus moves in, is trapped, and Cancel returns it to Publish.
  const publish = publishPanel(page).getByRole('button', { name: 'Publish', exact: true });
  await tabTo(page, publish);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Publish with override' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  const insideDialog = () => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
  expect(await insideDialog()).toBe(true);
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    expect(await insideDialog(), `Tab ${i + 1} stayed in the dialog`).toBe(true);
  }
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(await insideDialog(), `Shift+Tab ${i + 1} stayed in the dialog`).toBe(true);
  }
  await tabTo(page, dialog.getByRole('button', { name: 'Cancel' }));
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(publish).toBeFocused();

  // Escape also closes the dialog and returns focus to Publish.
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(publish).toBeFocused();
});
