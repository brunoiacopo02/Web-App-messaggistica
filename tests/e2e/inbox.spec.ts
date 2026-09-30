import { test, expect } from '@playwright/test';

const EMAIL = process.env.E2E_EMAIL!;
const PASSWORD = process.env.E2E_PASSWORD!;

test('login → console, poi inbox → vedo lista', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Entra' }).click();
  // Un admin (area `all`) atterra sulla console (`landingPath`).
  await expect(page).toHaveURL(/\/console(\?|$)/);
  await expect(page.getByText('Seleziona una chat')).toBeVisible();
  // L'inbox di prima resta raggiungibile.
  await page.goto('/inbox');
  await expect(page.getByText('Seleziona una conversazione')).toBeVisible();
});
