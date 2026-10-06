import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { SECTION_NAMES } from '../../src/lib/spec/sections';
import { createSession, login, rightPanel, resetAll, section, sendMessage } from './support/helpers';

type Status = 'complete' | 'partial' | 'missing';

// The statuses the scripted evaluator reports for the '#fixture' marker (tests/e2e/fixtures/llm-script.json).
function fixtureStatuses(): Record<string, Status> {
  const script = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'llm-script.json'), 'utf8')) as {
    rules: { kind?: string; match?: string; steps: { type: string; name?: string; args?: { section: string; status: Status } }[] }[];
  };
  const rule = script.rules.find((r) => r.kind === 'evaluator' && r.match === '#fixture');
  const statuses: Record<string, Status> = {};
  for (const step of rule?.steps ?? []) {
    if (step.type === 'tool-call' && step.name === 'report_section_status' && step.args) {
      statuses[step.args.section] = step.args.status;
    }
  }
  return statuses;
}

const LABEL: Record<Status, string> = { complete: 'Complete', partial: 'Partial', missing: 'Missing' };

test.beforeEach(async ({ request }) => {
  await resetAll(request);
});

test('AC-7: right panel shows per-section status and a score matching SR-6.3 for a known fixture', async ({ page }) => {
  const statuses = fixtureStatuses();
  expect(Object.keys(statuses)).toHaveLength(SECTION_NAMES.length);
  // SR-6.3 with default weights: round(100 × Σv / n), v = 1 / 0.5 / 0.
  const value: Record<Status, number> = { complete: 1, partial: 0.5, missing: 0 };
  const expected = Math.round((100 * SECTION_NAMES.reduce((sum, n) => sum + value[statuses[n]], 0)) / SECTION_NAMES.length);
  expect(expected).toBe(81);

  await login(page);
  await createSession(page, 'ABC-123');
  await sendMessage(page, 'Record the fixture. #fill-fixture');

  const panel = rightPanel(page);
  await panel.getByRole('button', { name: 'Evaluate now' }).click();
  await expect(panel.getByText(`Score (informational): ${expected}`)).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByTestId('gate-status')).toContainText('Ready');

  const list = panel.getByRole('region', { name: 'Section status' }).getByRole('listitem');
  await expect(list).toHaveCount(SECTION_NAMES.length);
  for (const name of SECTION_NAMES) {
    await expect(list.filter({ has: page.getByText(name, { exact: true }) })).toContainText(LABEL[statuses[name]]);
  }
  const missing = SECTION_NAMES.filter((n) => statuses[n] === 'missing');
  await expect(panel.getByRole('region', { name: 'Missing sections' })).toContainText(missing.join(', '));
  await expect(panel.getByRole('region', { name: 'Warnings' })).toContainText('Performance targets lack p95 numbers');

  // The center panel badges agree (they load with the page and after AI turns).
  await page.reload();
  await expect(section(page, 'Performance').locator('[data-status]')).toHaveText('Partial');
  await expect(section(page, 'Data Model').locator('[data-status]')).toHaveText('Missing');
  await expect(section(page, 'Scope').locator('[data-status]')).toHaveText('Complete');
});
