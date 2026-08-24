export type PlanKind = 'jest' | 'playwright' | 'maestro' | 'other';
export type PlanLanguage = 'typescript' | 'javascript' | 'yaml' | 'python' | 'other';

export interface QaPlanTemplate {
  kind: PlanKind;
  language: PlanLanguage;
  label: string;
  body: string;
}

const JEST_TEMPLATE_BODY = `import { describe, it, expect, beforeEach } from '@jest/globals';

// TODO: import the unit under test
// import { myFunction } from '../src/my-module';

describe('TODO: name this suite', () => {
  beforeEach(() => {
    // TODO: reset mocks / fixtures before each test
  });

  it('handles the happy path', () => {
    // TODO: call the unit under test with valid input and assert the result
    expect(true).toBe(true);
  });

  it('handles a documented edge case', () => {
    // TODO: e.g. empty input, a boundary value, or a rejected promise
    expect(true).toBe(true);
  });
});
`;

const PLAYWRIGHT_TEMPLATE_BODY = `import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';

test.describe('TODO: name this flow', () => {
  test('happy path', async ({ page }) => {
    await page.goto(BASE_URL);

    // TODO: replace with real selectors for this flow
    await page.getByLabel('Email').fill('user@example.com');
    await page.getByRole('button', { name: 'Submit' }).click();

    await expect(page.getByRole('heading', { name: 'TODO: expected result' })).toBeVisible();
  });
});
`;

// A Maestro flow file is two YAML documents separated by `---`: config
// (appId, and optionally name/tags) followed by the list of steps.
const MAESTRO_TEMPLATE_BODY = `appId: com.example.app
---
- launchApp
- tapOn: "Get Started"
- inputText: "user@example.com"
- assertVisible: "Welcome"
`;

export const QA_PLAN_TEMPLATES: Record<PlanKind, QaPlanTemplate> = {
  jest: { kind: 'jest', language: 'typescript', label: 'Jest', body: JEST_TEMPLATE_BODY },
  playwright: { kind: 'playwright', language: 'typescript', label: 'Playwright', body: PLAYWRIGHT_TEMPLATE_BODY },
  maestro: { kind: 'maestro', language: 'yaml', label: 'Maestro', body: MAESTRO_TEMPLATE_BODY },
  other: { kind: 'other', language: 'other', label: 'Other', body: '' },
};

export function getStarterTemplate(kind: string): QaPlanTemplate {
  return QA_PLAN_TEMPLATES[kind as PlanKind] ?? QA_PLAN_TEMPLATES.other;
}
