import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Menu, MenuItemButton } from 'dsh-host-menu'

const h = React.createElement
const registered = new Map()
let plugin
window.__ModuleLoader__ = { load({ factory }) { plugin = factory((name) => {
  if (name === 'react') return React
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MenuItemButton }
  throw new Error(`Unexpected module ${name}`)
}) } }
await import('/lib/client.js')
let dictionary
const ctx = {
  effect(fn) { fn() },
  locale: { register(_namespace, value) { dictionary = value }, bind() { return key => dictionary?.en?.[key] ?? key } },
  slots: { inject(_name, fn) { fn() }, register(spec, component) { registered.set(spec.name, component) } },
}
plugin.apply(ctx)
const Sidebar = registered.get('sidebar.workspaces.session.menu.item')
const Overlay = registered.get('shell.overlay')
const Header = registered.get('conversation.session.header.utilities')
function App() {
  const [open, setOpen] = useState(false)
  const [visible, setVisible] = useState(false)
  const [headerVisible, setHeaderVisible] = useState(true)
  return h(React.Fragment, null,
    h('button', { id: 'unrelated' }, 'Unrelated'),
    headerVisible && h(Header, { sessionId: 'current' }),
    h('div', { 'data-composer-input': '', contentEditable: true, role: 'textbox' }),
    h('button', { id: 'toggle-header', onClick: () => setHeaderVisible(v => !v) }, 'Toggle header'),
    h('button', { id: 'toggle-visible', onClick: () => setVisible(v => !v) }, 'Keep row actions visible'),
    h('div', { className: `row ${open ? 'menuOpen' : ''} ${visible ? 'keepVisible' : ''}`, 'data-row-key': 'session:selected' },
      h('span', { className: 'rowActions' },
        h(Menu, { open, portal: true, onClose: () => setOpen(false), anchor: h('button', { id: 'row-trigger', 'aria-label': 'Row actions', onClick: () => setOpen(true) }, 'Row actions') },
          h(Sidebar, { sessionId: 'selected', useMenuOpenState: () => [open, setOpen] })))),
    h('button', { id: 'open-menu', onClick: () => setOpen(true) }, 'Open menu externally'),
    h(Overlay, null))
}
createRoot(document.getElementById('root')).render(h(App))
