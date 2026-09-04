/**
 * End-to-end tests for the QA panel.
 *
 * These exist because of what shipped today: a JUnit fixture with the wrong
 * shape, a tab badge that lied, a dialog that burst out of its container, and a
 * proxy route the client never matched. Every one passed unit tests, tsc and
 * ESLint. The only thing that finds them is a real browser clicking real
 * buttons, so that is what these do — including the layout assertion, which is
 * a measurement rather than a screenshot.
 */
import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.OPENMEMORY_E2E_PROJECT_ID || '66e3dd3b-71fc-43c7-b1da-39d4806dd747';

async function openQaTab(page: Page) {
  await page.goto(`/projects/${PROJECT_ID}`);
  await page.getByRole('button', { name: /^QA(\s|$)/ }).click();
  await expect(page.getByRole('tab', { name: /^Runs/ })).toBeVisible();
}

function countFromTab(text: string | null): number {
  const match = /(\d+)\s*$/.exec((text ?? '').trim());
  return match ? Number(match[1]) : Number.NaN;
}

test('the QA sub-tabs show counts for both runs and plans', async ({ page }) => {
  await openQaTab(page);

  const runsTab = page.getByRole('tab', { name: /^Runs/ });
  const plansTab = page.getByRole('tab', { name: /^Plans/ });

  await expect(runsTab).toContainText(/\d/);
  await expect(plansTab).toContainText(/\d/);

  // A count is only useful if it matches the server. Compare against the API
  // rather than against itself.
  const apiRuns = await page.evaluate(async (id) => {
    const res = await fetch(`/api/projects/${id}/qa/runs`);
    return (await res.json())?.runs?.length ?? -1;
  }, PROJECT_ID);
  expect(countFromTab(await runsTab.textContent())).toBe(apiRuns);
});

test('a failed run shows its failing case first and collapses the passing ones', async ({ page }) => {
  await openQaTab(page);

  // Needs a run with BOTH outcomes: a run with zero passing cases has no
  // collapsed group to assert, so matching any failed run makes this flaky.
  // Click the counts text itself — `locator('div', {hasText})` matches every
  // ancestor too, and .last() lands on a leaf with no click handler.
  const failedRun = page.getByText(/[1-9]\d* passed · [1-9]\d* failed/).first();
  test.skip((await failedRun.count()) === 0, 'no failed run recorded to inspect');
  await failedRun.click();

  await expect(page.getByText('FAILURES FIRST')).toBeVisible();
  // The passing cases must be behind a count, not rendered as hundreds of rows.
  await expect(page.getByRole('button', { name: /\d+ passed/ })).toBeVisible();
});

test('case history opens and distinguishes the case time from the run total', async ({ page }) => {
  await openQaTab(page);

  // Click the counts text itself: `locator('div', {hasText})` matches every
  // ancestor too, and .last() lands on a leaf that does not carry the row's
  // click handler.
  const failedRun = page.getByText(/\d+ passed · [1-9]\d* failed/).first();
  test.skip((await failedRun.count()) === 0, 'no failed run recorded to inspect');
  await failedRun.click();

  await expect(page.getByText('FAILURES FIRST')).toBeVisible();

  // Read the case name out of the run the UI actually selected. Looking it up
  // from the API instead finds *a* failed run, not necessarily *this* one, and
  // the click then waits forever on a button that was never rendered.
  // The case row is the only button showing a test file path. Matching on the
  // accessible name fails here: the row concatenates name + file + message, so
  // getByRole({name}) never matches the case name on its own.
  const caseRow = page.getByRole('button').filter({ hasText: /\.(test|spec)\.(ts|js)/ }).first();
  await expect(caseRow).toBeVisible();
  await caseRow.click();

  await expect(page.getByText('Case history')).toBeVisible();
  // The 2800x misreport this feature already shipped once: these two labels must
  // both be present and distinct.
  await expect(page.getByText('Case time').first()).toBeVisible();
  await expect(page.getByText('Run total').first()).toBeVisible();
});

test('the run dialog keeps its script inside the dialog', async ({ page }) => {
  await openQaTab(page);
  await page.getByRole('tab', { name: /^Plans/ }).click();

  const runButton = page.getByRole('button', { name: 'Run', exact: true });
  test.skip((await runButton.count()) === 0, 'no plan available to run');
  await runButton.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  // The overflow bug that shipped: the <pre> was wider than the dialog and burst
  // out of it. A screenshot looked fine because the viewport clipped the excess,
  // so measure instead of looking.
  const overflow = await dialog.evaluate((node) => {
    const pre = node.querySelector('pre');
    if (!pre) return { hasPre: false, preWidth: 0, dialogWidth: 0, bodyScroll: 0, viewport: 0 };
    return {
      hasPre: true,
      preWidth: pre.clientWidth,
      dialogWidth: node.getBoundingClientRect().width,
      bodyScroll: document.body.scrollWidth,
      viewport: window.innerWidth,
    };
  });

  expect(overflow.hasPre).toBe(true);
  expect(overflow.preWidth).toBeLessThanOrEqual(overflow.dialogWidth);
  expect(overflow.bodyScroll).toBeLessThanOrEqual(overflow.viewport);
});

test('Run now executes the plan and the Runs count increments', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await openQaTab(page);
  await page.getByRole('tab', { name: /^Plans/ }).click();

  const runButton = page.getByRole('button', { name: 'Run', exact: true });
  test.skip((await runButton.count()) === 0, 'no plan available to run');

  const runsTab = page.getByRole('tab', { name: /^Runs/ });
  const before = countFromTab(await runsTab.textContent());

  await runButton.click();
  const runNow = page.getByRole('button', { name: 'Run now' });
  test.skip((await runNow.count()) === 0, 'Run now unavailable — the plan may have unsaved edits');
  await runNow.click();

  // The badge must reach before+1 without switching tabs: QaPanel is unmounted
  // here, so this only passes if the plans panel reports the new run upward.
  await expect
    .poll(async () => countFromTab(await runsTab.textContent()), { timeout: 45_000 })
    .toBe(before + 1);

  // The 404 that shipped: the proxy route the client calls must actually exist.
  expect(consoleErrors.filter((e) => e.includes('404'))).toEqual([]);
});

test('a saved QA plan version can be run explicitly and appears on the run row', async ({ page }) => {
  await openQaTab(page);
  await page.getByRole('tab', { name: /^Plans/ }).click();

  const name = `versioned e2e plan ${Date.now()}`;
  let planId: string | null = null;
  try {
    await page.getByRole('button', { name: 'New Plan', exact: true }).click();
    await page.locator('#plan-name').fill(name);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Plan name' })).toHaveValue(name);
    planId = await page.evaluate(async ({ id, planName }) => {
      const response = await fetch(`/api/projects/${id}/qa/plans`);
      const data = await response.json();
      return data.plans?.find((plan: { name: string; id: string }) => plan.name === planName)?.id ?? null;
    }, { id: PROJECT_ID, planName: name });
    expect(planId).toBeTruthy();

    // Freeze the newly-created working copy as v1 before editing it. The
    // automatic pre-save cut then deduplicates against this exact snapshot.
    await page.getByRole('button', { name: 'Save as version', exact: true }).click();
    await page.getByRole('textbox', { name: 'Version label' }).fill('home page only');
    await page.getByRole('button', { name: 'Save version', exact: true }).click();
    await expect(page.getByText('v1 — home page only', { exact: true })).toBeVisible();

    const script = page.locator('textarea').last();
    const v1Body = await script.inputValue();
    await script.fill(`${v1Body}\n// about page`);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();

    await page.getByRole('button', { name: 'Save as version', exact: true }).click();
    await page.getByRole('textbox', { name: 'Version label' }).fill('home page plus about');
    await page.getByRole('button', { name: 'Save version', exact: true }).click();
    await expect(page.getByText('v2 — home page plus about', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await page.getByRole('combobox', { name: 'Version to run' }).click();
    await page.getByRole('option', { name: /^v1 — home page only$/ }).click();
    await page.getByRole('button', { name: 'Run now', exact: true }).click();

    await page.getByRole('tab', { name: /^Runs/ }).click();
    await expect(page.getByText(`${name} · v1`, { exact: true })).toBeVisible({ timeout: 45_000 });
  } finally {
    if (planId) {
      await page.evaluate(async ({ id, revisionId }) => {
        await fetch(`/api/projects/${id}/qa/plans/${revisionId}`, { method: 'DELETE' });
      }, { id: PROJECT_ID, revisionId: planId });
    }
  }
});
