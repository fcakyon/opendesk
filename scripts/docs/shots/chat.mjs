// Shots for docs/src/content/docs/guides/live-chat/index.mdx and identity-verification.mdx.
import { around, button, labelled, settle } from '../helpers.mjs';
import { openWidget } from './brands.mjs';

const main = (p) => p.locator('main');
// The widget page is long: a tall window keeps every section on screen.
const tall = { width: 1440, height: 4800 };
const install = (p) => around(p, 'Paste this before </body>', 'Widget key');
const behaviour = (p) => p.locator('section').filter({ hasText: 'When the widget shows, what it asks for' }).last();
const identify = (p) => around(p, 'Identify signed-in users', 'Rotate secret');

export const shots = [
  {
    name: 'chat/open-widget',
    path: '/settings/brands',
    dim: true,
    clip: () => [{ x: 0, y: 0, width: 1, height: 1 }, { x: 1100, y: 899, width: 1, height: 1 }],
    pad: 0,
    highlight: [
      { target: (p) => p.getByRole('link', { name: 'Settings', exact: true }).last(), label: 1, badge: 'r' },
      { target: (p) => p.locator('aside a, nav a').filter({ hasText: /^\s*Brands and widgets/ }).first(), label: 2, badge: 'r' },
      { target: (p) => main(p).locator('a[href*="/settings/brands/"]').filter({ hasText: '/help/margin' }).first(), label: 3, inset: -2 },
    ],
  },
  {
    name: 'chat/install',
    path: '/settings/brands',
    viewport: tall,
    run: async (page) => {
      await openWidget(page, 'Margin', 'Marketing site');
      // Show the snippet as the hosted app writes it, wrapped so all of it reads.
      await install(page).locator('pre').first().evaluate((el) => {
        el.textContent = el.textContent.replace(/^<script src="[^"]*\/widget\/v1\.js"/, '<script src="https://app.opendesk.sh/widget/v1.js"');
        el.style.whiteSpace = 'pre-wrap';
      });
    },
    clip: install,
    pad: 24,
    highlight: [
      { target: (p) => install(p).locator('pre').first().locator('xpath=..'), label: 1, inset: 4, badge: 'l' },
      { target: (p) => install(p).getByText('Widget key', { exact: false }).last(), label: 2, inset: 8, badge: 'l' },
    ],
  },
  {
    name: 'chat/behaviour',
    path: '/settings/brands',
    viewport: tall,
    run: (page) => openWidget(page, 'Margin', 'Marketing site'),
    clip: behaviour,
    pad: 24,
    highlight: [
      { target: (p) => labelled(p, 'Show the widget'), label: 1, badge: 'tr' },
      { target: (p) => labelled(p, 'Ask for an email first'), label: 2, badge: 'tr' },
      { target: (p) => labelled(p, 'Allowed sites').locator('xpath=../..'), label: 3, inset: 4, badge: 'l' },
    ],
  },
  {
    name: 'chat/identify',
    path: '/settings/brands',
    viewport: tall,
    run: (page) => openWidget(page, 'Margin', 'Marketing site'),
    clip: identify,
    pad: 24,
    highlight: [
      { target: (p) => identify(p).locator('pre, textarea, code, [class*="mono"]').first().locator('xpath=..'), label: 1, inset: 4, badge: 'l' },
      { target: (p) => around(p, 'Widget secret', 'Rotate secret'), label: 2, inset: 3, badge: 'l' },
    ],
  },
  {
    // A chat whose visitor gave an address in the widget and has not verified it yet.
    name: 'chat/verification',
    path: '/inbox/open',
    run: async (page) => {
      await page.getByText('Can guests comment without an account?').first().click();
      await settle(page, 600);
      await page.locator('[data-testid="contact-verification"]').last().scrollIntoViewIfNeeded();
      await settle(page);
    },
    highlight: [
      { target: (p) => p.locator('[data-testid="visitor-presence"] [data-testid="contact-verification"]'), label: 1, badge: 'l' },
      { target: (p) => p.locator('[data-testid="contact-verification"]').last(), label: 2, badge: 'l' },
    ],
  },
  {
    name: 'chat/rotate',
    path: '/settings/brands',
    viewport: tall,
    run: async (page) => {
      await openWidget(page, 'Margin', 'Marketing site');
      await button(page, 'Rotate secret').click();
      await settle(page);
    },
    keepFocus: true,
    clip: (p) => p.locator('[role="dialog"], [role="alertdialog"]').filter({ visible: true }).last(),
    pad: 24,
  },
];
