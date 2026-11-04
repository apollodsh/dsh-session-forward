// Standalone real-browser regression. Set DSH_WORKSPACE to the read-only DSH
// checkout containing node_modules; uses an ephemeral Vite port and browser profile.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const workspace = process.env.DSH_WORKSPACE
assert.ok(workspace, 'Set DSH_WORKSPACE to a DSH source checkout with dependencies installed')
const requireHost = createRequire(join(workspace, 'package.json'))
const requireWeb = createRequire(join(workspace, 'apps/web/package.json'))
const { chromium } = requireWeb('playwright')
const { createServer } = await import(pathToFileURL(requireHost.resolve('vite')))
const primitives = join(workspace, 'packages/client/ui-primitives')
const hostRequire = createRequire(join(primitives, 'package.json'))
const server = await createServer({
  configFile: false, root, logLevel: 'error',
  resolve: { alias: [
    { find: 'dsh-host-menu', replacement: join(primitives, 'src/Menu.tsx') },
    { find: /^react-dom\/client$/, replacement: hostRequire.resolve('react-dom/client') },
    { find: /^react-dom$/, replacement: hostRequire.resolve('react-dom') },
    { find: /^react$/, replacement: hostRequire.resolve('react') },
  ] },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [root, workspace] } },
})
let browser
try {
  await server.listen()
  const port = server.httpServer.address().port
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  page.on('pageerror', error => console.error(error))
  await page.goto(`http://127.0.0.1:${port}/test/browser-focus.html`)
  await page.waitForSelector('#open-menu')
  // Disable the browser's default mouse focus, as in browsers where clicking a
  // button doesn't focus it. Pointer events and all React/host behavior are real.
  await page.evaluate(() => document.addEventListener('mousedown', e => e.preventDefault(), true))
  for (const visible of [false, true]) {
    if (visible) await page.click('#toggle-visible')
    await page.click('#open-menu')
    await page.focus('#unrelated')
    await page.getByRole('menuitem', { name: 'Forward' }).click()
    await page.waitForSelector('[data-dsh-session-forward="dialog"]')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-dsh-session-forward="dialog"]', { state: 'detached' })
    const expected = visible ? '#row-trigger' : '[data-dsh-session-forward="trigger"]'
    await page.waitForFunction(selector => document.activeElement === document.querySelector(selector), expected)
    assert.equal(await page.locator('.rowActions').evaluate(el => getComputedStyle(el).display === 'none'), !visible)
    console.log(`PASS ${visible ? 'visible row trigger' : 'hidden row fallback'} restores focus on Escape`)
  }
  await page.click('#toggle-visible')
  await page.click('#toggle-header')
  await page.click('#open-menu')
  await page.getByRole('menuitem', { name: 'Forward' }).click()
  await page.waitForSelector('[data-dsh-session-forward="dialog"]')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-dsh-session-forward="dialog"]', { state: 'detached' })
  assert.equal(await page.locator('[data-composer-input]').evaluate(el => document.activeElement === el), true)
  console.log('PASS hidden row without header restores focus to composer')
} finally {
  await browser?.close()
  await server.close()
}
