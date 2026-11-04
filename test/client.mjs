import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

// Exercise the actual registered components with a small platform/React stand-in.
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const timers = new Map()
let nextTimer = 0
const body = {}
const document = {
  body, activeElement: body,
  querySelector: () => null,
  createElement: () => ({ dataset: {}, parentNode: null }),
  head: {
    appendChild(node) { node.parentNode = this },
    removeChild(node) { node.parentNode = null },
  },
}
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  Component: class {},
  useSyncExternalStore: (_subscribe, get) => get(),
  useRef: (value) => ({ current: value }),
  useEffect: () => {},
}
const MenuItemButton = function MenuItemButton() {}
let plugin
const requests = []
const window = {
  __ModuleLoader__: { load({ id, factory }) {
    assert.equal(id, 'dsh-session-forward')
    plugin = factory((name) => {
      if (name === 'react') return React
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MenuItemButton }
      throw new Error(`Unexpected platform module: ${name}`)
    })
  } },
  setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id },
  clearTimeout(id) { timers.delete(id) },
}
vm.runInNewContext(source, {
  window, document, console,
  fetch: async (url, options) => {
    requests.push({ url, options })
    return { status: 200, json: async () => ({ ok: true, bundle: { messages: [] }, summary: { title: 'Selected session', messages: 0 } }) }
  },
}, { filename: 'lib/client.js' })

function host() {
  const registrations = new Map()
  const cleanups = []
  let dictionary
  let language = 'en'
  const ctx = {
    effect(start) { const cleanup = start(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    locale: {
      register(namespace, dict) { assert.equal(namespace, 'session-forward'); dictionary = dict; return () => { dictionary = undefined } },
      bind(namespace) { assert.equal(namespace, 'session-forward'); return (key) => dictionary?.[language]?.[key] ?? key },
    },
    slots: {
      inject(_name, register) { const cleanup = register(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
      register(spec, component) {
        assert.equal(registrations.has(spec.name), false)
        registrations.set(spec.name, { spec, component })
        return () => registrations.delete(spec.name)
      },
    },
  }
  return { ctx, registrations, setLanguage(value) { language = value }, unload() { for (const cleanup of cleanups.reverse()) cleanup() } }
}
function flushTimer() {
  const entry = timers.entries().next().value
  assert.ok(entry, 'a deferred timer was scheduled')
  const [id, timer] = entry
  assert.equal(timer.ms, 0)
  timers.delete(id)
  timer.fn()
}
function find(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) { const match = find(child, predicate); if (match) return match }
  } else if (node && typeof node === 'object') {
    if (predicate(node)) return node
    return find(node.props?.children, predicate)
  }
  return undefined
}
function dialog(overlay) {
  const boundary = overlay({})
  assert.ok(boundary, 'overlay opens')
  const view = boundary.props.children[0]
  return view.type(view.props)
}

assert.equal(plugin.isPlugin, true)
const first = host()
plugin.apply(first.ctx)
const sidebar = first.registrations.get('sidebar.workspaces.session.menu.item')
const overlay = first.registrations.get('shell.overlay')?.component
assert.ok(sidebar && overlay, 'sidebar and overlay are registered')
assert.equal(sidebar.spec.locale, 'session-forward')
assert.equal(overlay({}), null)
let menuOpen = true
const sidebarTree = sidebar.component({ sessionId: 'selected / session', useMenuOpenState: () => [menuOpen, (value) => { menuOpen = value }] })
const menu = find(sidebarTree, (node) => node.type === MenuItemButton)
assert.ok(menu, 'sidebar uses the platform menu item')
assert.equal(typeof menu.props.onSelect, 'function')
assert.notEqual(menu.props.children[0], 'menu.forward', 'sidebar uses registered locale')
const english = menu.props.children[0]
first.setLanguage('zh')
assert.notEqual(find(sidebar.component({ sessionId: 'other', useMenuOpenState: () => [true, () => {}] }), (node) => node.type === MenuItemButton).props.children[0], english)
const focusCalls = []
const persistentTrigger = { isConnected: true, focus: (options) => focusCalls.push(options) }
menu.props.onSelect()
assert.equal(menuOpen, false, 'selection closes the menu immediately')
assert.equal(overlay({}), null, 'dialog waits for menu focus restoration')
document.activeElement = persistentTrigger
flushTimer()
let tree = dialog(overlay)
const prepare = find(tree, (node) => node.type === 'button' && node.props.children.includes(first.ctx.locale.bind('session-forward')('action.prepare')))
assert.ok(prepare, 'localized dialog exposes prepare action')
prepare.props.onClick()
await new Promise((resolve) => setImmediate(resolve))
assert.equal(requests.length, 1)
assert.equal(requests[0].url, 'api/session-forward.export?sessionId=selected%20%2F%20session')
assert.equal(requests[0].options.method, 'GET')
tree = dialog(overlay)
assert.ok(find(tree, (node) => node.props?.children?.includes('Selected session')), 'export result is rendered')
const close = find(tree, (node) => node.type === 'button' && node.props.className === 'dshsf-close')
close.props.onClick()
assert.equal(overlay({}), null)
assert.equal(focusCalls.length, 1, 'closing restores focus to the persistent menu trigger')
assert.equal(focusCalls[0].preventScroll, true)

// A pending sidebar action must not reopen the overlay after unload.
menu.props.onSelect()
assert.equal(timers.size, 1)
first.unload()
assert.equal(timers.size, 0)
assert.equal(first.registrations.size, 0)
const second = host()
plugin.apply(second.ctx)
assert.ok(second.registrations.has('sidebar.workspaces.session.menu.item'))
assert.ok(second.registrations.has('shell.overlay'))
assert.equal(second.registrations.get('shell.overlay').component({}), null)
second.unload()
assert.equal(second.registrations.size, 0)
console.log('PASS client sidebar, dialog, locale and lifecycle behavior')
