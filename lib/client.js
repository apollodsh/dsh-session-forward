/**
 * dsh-session-forward · 浏览器半边（零构建手写产物）
 *
 * 契约：window.__ModuleLoader__.load({ id, factory })；factory(require) 返回
 *       { isPlugin, inject, apply }。require 解析 DSH 的平台模块表。
 *
 * 三个注册（都在 apply 里，先 inject 后 register）：
 *   1. conversation.session.header.utilities（session 作用域 list 座位，id 'session-forward'）
 *      —— 页头 28px 方形图标按钮，点击把「当前 sessionId」塞进模块级 store 并开弹窗。
 *   2. shell.overlay（root 作用域 list 座位，id 'session-forward.dialog'）
 *      —— 整页浮层，默认点透；只有 store.open 为 true 时才渲染，根节点自己叫回指针事件。
 *      注意：root 座位的 standardProps 不带 t（只有 useSessions/useWorkspaces/...），
 *      所以文案一律走 apply() 里 ctx.locale.bind(NS) 得到的 bridge.t 兜底。
 *
 * 数据契约（与 lib/index.js 的 Host 路由一一对应，全局相对路径、同源 fetch）：
 *   GET  api/session-forward.export?sessionId=<id>
 *        → { ok:true, fileName, bundle, markdown, summary:{ title, messages, userMessages,
 *            assistantMessages, omitted:{toolCalls,toolResults,reasoning,images,files,truncated},
 *            bytes } } | { ok:false, error }
 *   POST api/session-forward.import  body { bundle, workspaceId? }
 *        → { ok:true, sessionId, title, messages } | { ok:false, error }
 *
 * 健壮性：座位里的组件一旦抛错整条 seat 就变空白，所以
 *   - 弹窗外面套 ErrorBoundary；
 *   - 所有 ctx 服务（uiWorkspace / sessions）只在调用点用 ctx.get + try/catch 取；
 *   - 全部副作用（style、keydown、定时器、store 订阅）都有清理出口。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-forward',
  factory: (require) => {
    'use strict'

    const React = require('react')
    const MenuItemButton = require('@deepseek-ai/dsh-client-ui-primitives').MenuItemButton
    const h = React.createElement

    const NS = 'session-forward'
    const PKG = 'dsh-session-forward'
    const BUNDLE_FORMAT = 'dsh-session-forward'
    /** 同源相对路径：浏览器按文档 base 解析（Host 注册的是 /api/...，不要带前导斜杠） */
    const ROUTE_EXPORT = 'api/session-forward.export'
    const ROUTE_IMPORT = 'api/session-forward.import'
    const ROUTE_SHARE = 'api/session-forward.share'
    const FILE_ACCEPT = '.json,.dshchat,application/json'
    const FALLBACK_FILE_NAME = 'dsh-session.dshchat.json'
    const FALLBACK_HTML_FILE_NAME = 'dsh-session.dshchat.html'
    const DIALOG_TITLE_ID = 'dshsf-dialog-title'
    const EMPTY_LIST = []
    /** 导入后等待浏览器会话列表追上来的重试预算：8 × 120ms ≈ 1s */
    const OPEN_ATTEMPTS = 8
    const OPEN_RETRY_MS = 120
    /** 触发下载用的 blob URL 延迟回收（太早 revoke 会让部分浏览器取消下载） */
    const BLOB_REVOKE_MS = 20_000

    /* ================================================================
     * 0. 小工具
     * ================================================================ */

    function isObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }

    function messageOf(error) {
      if (error === null || error === undefined) return ''
      if (typeof error === 'string') return error
      if (typeof error.message === 'string') return error.message
      try {
        return String(error)
      } catch (caught) {
        return ''
      }
    }

    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 B'
      if (bytes < 1024) return String(bytes) + ' B'
      if (bytes < 1024 * 1024) return String(Math.round((bytes / 1024) * 10) / 10) + ' KB'
      return String(Math.round((bytes / (1024 * 1024)) * 10) / 10) + ' MB'
    }

    /** 带本地化键的失败：渲染时再翻译，避免把某种语言的字符串钉在 store 里 */
    function failureOf(key, params, detail) {
      const text = typeof detail === 'string' ? detail.trim() : ''
      return {
        key: key,
        params: params === undefined ? null : params,
        detail: text === '' ? null : text,
      }
    }

    function taggedFailure(key, detail) {
      const error = new Error(key)
      error.dshsfKey = key
      error.dshsfDetail = typeof detail === 'string' && detail !== '' ? detail : null
      return error
    }

    /* ---------------------------------------------------------------
     * 计时器登记表：插件卸载时全部清掉，不留悬挂定时器
     * --------------------------------------------------------------- */

    const pendingTimeouts = new Set()
    const pendingWaiters = new Set()

    function later(fn, ms) {
      if (typeof window === 'undefined' || typeof window.setTimeout !== 'function') return 0
      const id = window.setTimeout(function () {
        pendingTimeouts.delete(id)
        try {
          fn()
        } catch (error) {
          /* 定时器里的异常不该冒到全局 */
        }
      }, ms)
      pendingTimeouts.add(id)
      return id
    }

    function sleep(ms) {
      return new Promise(function (resolve) {
        if (typeof window === 'undefined' || typeof window.setTimeout !== 'function') {
          resolve()
          return
        }
        const entry = { id: 0, resolve: resolve }
        entry.id = window.setTimeout(function () {
          pendingWaiters.delete(entry)
          resolve()
        }, ms)
        pendingWaiters.add(entry)
      })
    }

    function disposeTimers() {
      pendingTimeouts.forEach(function (id) {
        try {
          window.clearTimeout(id)
        } catch (error) {
          /* ignore */
        }
      })
      pendingTimeouts.clear()
      pendingWaiters.forEach(function (entry) {
        try {
          window.clearTimeout(entry.id)
        } catch (error) {
          /* ignore */
        }
        try {
          entry.resolve()
        } catch (error) {
          /* ignore */
        }
      })
      pendingWaiters.clear()
    }

    /* ================================================================
     * 1. 跨座位 store（页头按钮 → 全屏浮层）
     * ================================================================ */

    const INITIAL_STATE = {
      open: false,
      /** 打开弹窗时从页头 props 抄下来的会话 id；root 座位自己拿不到会话 */
      sessionId: undefined,
      /** idle | exporting | exported | importing | imported */
      status: 'idle',
      /** { key, params, detail } —— 渲染时才翻译 */
      failure: null,
      /** { key, params } —— 成功提示 */
      notice: null,
      /** 导出成功后的 { fileName, htmlFileName, html, bundle, markdown, summary } */
      result: null,
      /** 分享链接 { url, expiresAt, urls }；null = 还没创建 */
      share: null,
      /** idle | copied */
      copyState: 'idle',
      /** 导入成功后的 { sessionId, title, messages }；自动打开失败时保留给「再试一次」 */
      importInfo: null,
      /** 用户在目标工作区下拉里的选择；null = 自动（当前会话所在的 workspace） */
      workspaceChoice: null,
    }

    let dialogState = INITIAL_STATE
    const dialogSubs = new Set()

    function setDialog(patch) {
      dialogState = Object.assign({}, dialogState, patch)
      dialogSubs.forEach(function (fn) {
        try {
          fn()
        } catch (error) {
          /* 单个订阅者出错不影响其它订阅者 */
        }
      })
    }

    const dialogStore = {
      get: function () {
        return dialogState
      },
      subscribe: function (fn) {
        dialogSubs.add(fn)
        return function () {
          dialogSubs.delete(fn)
        }
      },
    }

    function useDialogState() {
      return React.useSyncExternalStore(dialogStore.subscribe, dialogStore.get, dialogStore.get)
    }

    /** 弹窗关闭时优先恢复的触发器，以及侧栏触发器隐藏时的回退。 */
    let returnFocusElement = null
    let returnFocusToHeader = false
    /** 操作票号：任何新操作 / 关闭都会让上一次异步链的结果作废 */
    let operation = 0
    /** 插件卸载后，仍在飞的异步链不再碰 store / 服务 */
    let disposed = false

    /** 这一轮异步结果是不是已经过期（被新操作顶掉 / 弹窗关了 / 插件卸载了） */
    function stale(token) {
      return token !== operation || disposed === true
    }

    /* ---------------------------------------------------------------
     * 服务访问：一律 ctx.get + try/catch，拿不到就优雅降级
     * --------------------------------------------------------------- */

    const bridge = {
      /** apply() 里替换成 ctx.locale.bind(NS) */
      t: function (key) {
        return key
      },
    }

    function serviceOf(name) {
      const ctx = bridge.ctx
      if (ctx === undefined || ctx === null) return undefined
      try {
        if (typeof ctx.get === 'function') {
          const service = ctx.get(name)
          if (service !== undefined && service !== null) return service
        }
      } catch (error) {
        return undefined
      }
      return undefined
    }

    function translatorOf(props) {
      if (props && typeof props.t === 'function') return props.t
      return bridge.t
    }

    /* ================================================================
     * 2. 弹窗状态迁移
     * ================================================================ */

    function openDialog(sessionId, triggerElement, fallbackToHeader) {
      operation += 1
      returnFocusElement = triggerElement || null
      returnFocusToHeader = fallbackToHeader === true
      setDialog({
        open: true,
        sessionId: typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined,
        status: 'idle',
        failure: null,
        notice: null,
        result: null,
        share: null,
        copyState: 'idle',
        importInfo: null,
        workspaceChoice: null,
      })
    }

    function closeDialog() {
      operation += 1
      const focusTarget = returnFocusElement
      const fallbackToHeader = returnFocusToHeader
      returnFocusElement = null
      returnFocusToHeader = false
      setDialog({
        open: false,
        status: 'idle',
        failure: null,
        notice: null,
        result: null,
        share: null,
        copyState: 'idle',
        importInfo: null,
        workspaceChoice: null,
      })
      // A connected sidebar button may still be display:none after the menu
      // closes. Check focus before falling back to the header or the composer.
      if (!focusElement(focusTarget) && fallbackToHeader) {
        if (!focusElement(document.querySelector('[data-dsh-session-forward="trigger"]'))) {
          focusElement(document.querySelector('[data-composer-input]'))
        }
      }
    }

    function focusElement(element) {
      if (!element || element.isConnected === false || typeof element.focus !== 'function') return false
      try {
        element.focus({ preventScroll: true })
      } catch (error) {
        try { element.focus() } catch (caught) { return false }
      }
      return document.activeElement === element
    }

    /* ================================================================
     * 3. 网络：导出 / 导入 / 下载 / 剪贴板
     * ================================================================ */

    async function readJson(response) {
      try {
        return await response.json()
      } catch (error) {
        return undefined
      }
    }

    async function runExport() {
      const sessionId = dialogState.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') {
        setDialog({ status: 'idle', failure: failureOf('error.noSession') })
        return
      }
      operation += 1
      const token = operation
      setDialog({
        status: 'exporting',
        failure: null,
        notice: null,
        result: null,
        share: null,
        copyState: 'idle',
      })
      try {
        const url = ROUTE_EXPORT + '?sessionId=' + encodeURIComponent(sessionId)
        const response = await fetch(url, {
          method: 'GET',
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
          cache: 'no-store',
        })
        const payload = await readJson(response)
        if (stale(token)) return
        if (!isObject(payload)) {
          setDialog({ status: 'idle', failure: failureOf('error.badResponse', { status: response.status }) })
          return
        }
        if (payload.ok !== true || !isObject(payload.bundle) || !Array.isArray(payload.bundle.messages)) {
          const detail = typeof payload.error === 'string' ? payload.error : null
          setDialog({ status: 'idle', failure: failureOf('error.exportFailed', null, detail) })
          return
        }
        const summary = isObject(payload.summary) ? payload.summary : null
        setDialog({
          status: 'exported',
          failure: null,
          notice: { key: 'export.ready', params: null },
          result: {
            fileName: typeof payload.fileName === 'string' && payload.fileName !== ''
              ? payload.fileName
              : FALLBACK_FILE_NAME,
            bundle: payload.bundle,
            markdown: typeof payload.markdown === 'string' ? payload.markdown : '',
            html: typeof payload.html === 'string' ? payload.html : '',
            htmlFileName: typeof payload.htmlFileName === 'string' ? payload.htmlFileName : '',
            summary: summary === null
              ? { messages: payload.bundle.messages.length }
              : summary,
          },
        })
      } catch (error) {
        if (stale(token)) return
        setDialog({ status: 'idle', failure: failureOf('error.network', null, messageOf(error)) })
      }
    }

    function downloadBlob(blob, fileName) {
      const objectUrl = URL.createObjectURL(blob)
      try {
        const anchor = document.createElement('a')
        anchor.href = objectUrl
        anchor.download = fileName
        anchor.rel = 'noopener'
        anchor.style.display = 'none'
        document.body.appendChild(anchor)
        try {
          anchor.click()
        } finally {
          if (anchor.parentNode !== null) anchor.parentNode.removeChild(anchor)
        }
      } finally {
        later(function () {
          try {
            URL.revokeObjectURL(objectUrl)
          } catch (error) {
            /* ignore */
          }
        }, BLOB_REVOKE_MS)
      }
    }

    function saveBundleFile() {
      const result = dialogState.result
      if (result === null || !isObject(result.bundle)) return
      const fileName = typeof result.fileName === 'string' && result.fileName !== ''
        ? result.fileName
        : FALLBACK_FILE_NAME
      try {
        const text = JSON.stringify(result.bundle, null, 2) + '\n'
        downloadBlob(new Blob([text], { type: 'application/json' }), fileName)
        setDialog({ failure: null, notice: { key: 'save.done', params: { fileName: fileName } } })
      } catch (error) {
        setDialog({ failure: failureOf('error.save', null, messageOf(error)) })
      }
    }

    /* ---------------- 零安装分享：保存网页 / 复制链接 ---------------- */

    function saveHtmlFile(t) {
      const result = dialogState.result
      if (result === null || !isObject(result.bundle)) return
      if (typeof result.html !== 'string' || result.html === '') {
        setDialog({ failure: failureOf('error.restartRequired') })
        return
      }
      const fileName = typeof result.htmlFileName === 'string' && result.htmlFileName !== ''
        ? result.htmlFileName
        : FALLBACK_HTML_FILE_NAME
      try {
        downloadBlob(new Blob([result.html], { type: 'text/html;charset=utf-8' }), fileName)
        setDialog({ failure: null, notice: { key: 'save.htmlDone', params: { fileName: fileName } } })
      } catch (error) {
        setDialog({ failure: failureOf('error.save', null, messageOf(error)) })
      }
    }

    /** 把毫秒时间戳格式化成「2026-11-03 22:30」 */
    function formatShareExpiry(stamp) {
      if (typeof stamp !== 'number' || !Number.isFinite(stamp)) return ''
      try {
        return new Date(stamp).toLocaleString(undefined, {
          year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        })
      } catch (error) {
        return new Date(stamp).toISOString().slice(0, 16).replace('T', ' ')
      }
    }

    /**
     * 让 Host 起一个临时分享页并返回局域网链接：直接复制，粘到微信/飞书即可。
     * 链接 24 小时有效；同一 Wi-Fi/局域网可打开。
     */
    async function copyShareLink() {
      const sessionId = dialogState.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') {
        setDialog({ failure: failureOf('error.noSession') })
        return
      }
      operation += 1
      const token = operation
      setDialog({ failure: null, notice: null, share: null })
      try {
        const response = await fetch(ROUTE_SHARE, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          credentials: 'same-origin',
          cache: 'no-store',
          body: JSON.stringify({ sessionId: sessionId }),
        })
        const payload = await readJson(response)
        if (stale(token)) return
        if (!isObject(payload) || payload.ok !== true || typeof payload.url !== 'string' || payload.url === '') {
          const detail = isObject(payload) && typeof payload.error === 'string' ? payload.error : null
          setDialog({ failure: failureOf('error.shareFailed', null, detail) })
          return
        }
        setDialog({
          failure: null,
          share: {
            url: payload.url,
            expiresAt: typeof payload.expiresAt === 'number' ? payload.expiresAt : null,
            urls: Array.isArray(payload.urls) ? payload.urls.filter(isNonEmptyString) : [],
          },
          notice: { key: 'share.done' },
        })
        try {
          await writeClipboard(payload.url)
        } catch (error) {
          setDialog({ notice: { key: 'share.copyManually' } })
        }
      } catch (error) {
        if (stale(token)) return
        setDialog({ failure: failureOf('error.network', null, messageOf(error)) })
      }
    }

    async function copyShareUrl() {
      const share = dialogState.share
      if (share === null || typeof share.url !== 'string') return
      try {
        await writeClipboard(share.url)
        setDialog({ failure: null, notice: { key: 'share.done' } })
      } catch (error) {
        setDialog({ failure: failureOf('error.copy', null, messageOf(error)) })
      }
    }

    function isNonEmptyString(value) {
      return typeof value === 'string' && value !== ''
    }

    async function writeClipboard(text) {
      const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
      if (clipboard !== undefined && clipboard !== null && typeof clipboard.writeText === 'function') {
        await clipboard.writeText(text)
        return
      }
      // 兜底：没有异步剪贴板（非安全上下文 / 权限被拒）时用临时 textarea
      if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
        throw new Error('clipboard unavailable')
      }
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.top = '-1000px'
      area.style.left = '-1000px'
      area.style.opacity = '0'
      document.body.appendChild(area)
      try {
        area.select()
        const copied = document.execCommand('copy')
        if (copied !== true) throw new Error('copy was rejected')
      } finally {
        if (area.parentNode !== null) area.parentNode.removeChild(area)
      }
    }

    async function copyMarkdown() {
      const result = dialogState.result
      if (result === null || typeof result.markdown !== 'string' || result.markdown === '') return
      try {
        await writeClipboard(result.markdown)
        setDialog({ failure: null, copyState: 'copied', notice: { key: 'copy.done', params: null } })
      } catch (error) {
        setDialog({ failure: failureOf('error.copy', null, messageOf(error)) })
      }
    }

    function readFileText(file) {
      if (file !== null && typeof file.text === 'function') return file.text()
      return new Promise(function (resolve, reject) {
        const reader = new FileReader()
        reader.onload = function () {
          resolve(typeof reader.result === 'string' ? reader.result : '')
        }
        reader.onerror = function () {
          reject(reader.error === null || reader.error === undefined ? new Error('read failed') : reader.error)
        }
        reader.readAsText(file)
      })
    }

    /**
     * 导入成功后请浏览器打开这条新会话。
     * 浏览器侧的会话列表是异步 feed：刚建好的会话可能还没进 snapshot，
     * 这时 openSession 会抛 `sessions.retain: unknown session`，所以先要一次
     * 列表刷新，再短暂重试几次。重试都在同一次点击的异步链里，没有常驻定时器。
     * @returns {Promise<{ok:true} | {ok:false, cancelled?:true, reason?:string, detail?:string|null}>}
     */
    async function openImportedSession(sessionId, token) {
      const workspace = serviceOf('uiWorkspace')
      if (workspace === undefined || typeof workspace.openSession !== 'function') {
        return { ok: false, reason: 'error.openUnavailable', detail: null }
      }
      try {
        const sessions = serviceOf('sessions')
        if (sessions !== undefined && sessions !== null && typeof sessions.refreshList === 'function') {
          await sessions.refreshList()
        }
      } catch (error) {
        /* 刷新失败就只靠下面的重试 */
      }
      let lastMessage = ''
      for (let attempt = 0; attempt < OPEN_ATTEMPTS; attempt += 1) {
        if (stale(token)) return { ok: false, cancelled: true }
        try {
          workspace.openSession(sessionId)
          return { ok: true }
        } catch (error) {
          lastMessage = messageOf(error)
        }
        await sleep(OPEN_RETRY_MS)
      }
      return {
        ok: false,
        reason: 'error.open',
        detail: lastMessage === '' ? null : lastMessage,
      }
    }

    async function runImport(file, workspaceId) {
      if (file === null || file === undefined) return
      operation += 1
      const token = operation
      setDialog({ status: 'importing', failure: null, notice: null, importInfo: null })

      let bundle
      try {
        const text = await readFileText(file)
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch (error) {
          throw taggedFailure('error.parse', messageOf(error))
        }
        if (!isObject(parsed)) throw taggedFailure('error.format', null)
        if (parsed.format !== BUNDLE_FORMAT) throw taggedFailure('error.format', null)
        bundle = parsed
      } catch (error) {
        if (stale(token)) return
        const key = typeof error.dshsfKey === 'string' ? error.dshsfKey : 'error.readFile'
        const detail = typeof error.dshsfDetail === 'string'
          ? error.dshsfDetail
          : (key === 'error.readFile' ? messageOf(error) : null)
        setDialog({ status: 'idle', failure: failureOf(key, null, detail) })
        return
      }

      try {
        const body = { bundle: bundle }
        if (typeof workspaceId === 'string' && workspaceId !== '') body.workspaceId = workspaceId
        const response = await fetch(ROUTE_IMPORT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
          credentials: 'same-origin',
          cache: 'no-store',
        })
        const payload = await readJson(response)
        if (stale(token)) return
        if (!isObject(payload)) {
          setDialog({ status: 'idle', failure: failureOf('error.badResponse', { status: response.status }) })
          return
        }
        if (payload.ok !== true || typeof payload.sessionId !== 'string' || payload.sessionId === '') {
          const detail = typeof payload.error === 'string' ? payload.error : null
          setDialog({ status: 'idle', failure: failureOf('error.importFailed', null, detail) })
          return
        }
        const info = {
          sessionId: payload.sessionId,
          title: typeof payload.title === 'string' ? payload.title : '',
          messages: typeof payload.messages === 'number' && Number.isFinite(payload.messages)
            ? payload.messages
            : 0,
        }
        setDialog({
          status: 'imported',
          importInfo: info,
          failure: null,
          notice: info.title === ''
            ? { key: 'import.doneNoTitle', params: null }
            : { key: 'import.done', params: { title: info.title } },
        })
        const opened = await openImportedSession(info.sessionId, token)
        if (stale(token)) return
        if (opened.ok === true) {
          closeDialog()
          return
        }
        if (opened.cancelled === true) return
        setDialog({ failure: failureOf(opened.reason, null, opened.detail) })
      } catch (error) {
        if (stale(token)) return
        setDialog({ status: 'idle', failure: failureOf('error.network', null, messageOf(error)) })
      }
    }

    async function retryOpenImported() {
      const info = dialogState.importInfo
      if (info === null || typeof info.sessionId !== 'string' || info.sessionId === '') return
      operation += 1
      const token = operation
      setDialog({ failure: null })
      const opened = await openImportedSession(info.sessionId, token)
      if (stale(token)) return
      if (opened.ok === true) {
        closeDialog()
        return
      }
      if (opened.cancelled === true) return
      setDialog({ failure: failureOf(opened.reason, null, opened.detail) })
    }

    /* ================================================================
     * 4. 工作区下拉的取值（workspace 元素字段：workspaceId/title/path/sessionIds）
     * ================================================================ */

    function workspaceIdOf(workspace) {
      if (!isObject(workspace)) return ''
      if (typeof workspace.workspaceId === 'string' && workspace.workspaceId !== '') return workspace.workspaceId
      if (typeof workspace.id === 'string' && workspace.id !== '') return workspace.id
      return ''
    }

    function workspaceTitleOf(workspace) {
      if (!isObject(workspace)) return ''
      if (typeof workspace.title === 'string' && workspace.title !== '') return workspace.title
      if (typeof workspace.path === 'string' && workspace.path !== '') return workspace.path
      return workspaceIdOf(workspace)
    }

    function containsSession(workspace, sessionId) {
      if (!isObject(workspace) || typeof sessionId !== 'string' || sessionId === '') return false
      return Array.isArray(workspace.sessionIds) && workspace.sessionIds.indexOf(sessionId) !== -1
    }

    function containingWorkspace(items, sessionId) {
      if (!Array.isArray(items)) return undefined
      for (let index = 0; index < items.length; index += 1) {
        if (containsSession(items[index], sessionId)) return items[index]
      }
      return undefined
    }

    /** 下拉的当前值：用户没选过就落在「当前会话所在的工作区」，找不到则 ''（默认位置） */
    function selectedWorkspaceId(state, items) {
      if (typeof state.workspaceChoice === 'string') return state.workspaceChoice
      const owning = containingWorkspace(items, state.sessionId)
      return owning === undefined ? '' : workspaceIdOf(owning)
    }

    /* ================================================================
     * 5. 翻译辅助
     * ================================================================ */

    function failureText(failure, t) {
      if (!isObject(failure)) return ''
      const base = t(failure.key, isObject(failure.params) ? failure.params : undefined)
      if (typeof failure.detail === 'string' && failure.detail !== '') {
        return base + ' ' + t('error.detail', { message: failure.detail })
      }
      return base
    }

    function noticeText(notice, t) {
      if (!isObject(notice)) return ''
      return t(notice.key, isObject(notice.params) ? notice.params : undefined)
    }

    /* ================================================================
     * 6. React：页头触发按钮
     * ================================================================ */

    const ICON_FORWARD = h('svg', {
      width: 15,
      height: 15,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.3,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
    },
      h('path', { d: 'M9.6 2.6H5.1a1.1 1.1 0 0 0-1.1 1.1v8.6a1.1 1.1 0 0 0 1.1 1.1h4.5' }),
      h('path', { d: 'M8.2 8h5.6' }),
      h('path', { d: 'M11.2 5.4 13.8 8l-2.6 2.6' }),
    )

    const ICON_CLOSE = h('svg', {
      width: 14,
      height: 14,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
      'aria-hidden': 'true',
    },
      h('path', { d: 'M3.9 3.9 12.1 12.1' }),
      h('path', { d: 'M12.1 3.9 3.9 12.1' }),
    )

    function ForwardTrigger(props) {
      const t = translatorOf(props)
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined
      const onClick = function (event) {
        let element = null
        try {
          element = event && event.currentTarget ? event.currentTarget : null
        } catch (error) {
          element = null
        }
        try {
          openDialog(sessionId, element)
        } catch (error) {
          if (typeof console !== 'undefined') console.warn('[' + NS + '] could not open the dialog', error)
        }
      }
      return h('button', {
        type: 'button',
        className: 'dshsf-trigger',
        onClick: onClick,
        title: t('open'),
        'aria-label': t('open'),
        'aria-haspopup': 'dialog',
        'data-dsh-session-forward': 'trigger',
      },
        h('span', { className: 'dshsf-triggerIcon' }, ICON_FORWARD),
      )
    }

    /** The menu is portaled; identify its persistent anchor from the selected row. */
    function sidebarTrigger(sessionId) {
      const rows = document.querySelectorAll('[data-row-key]')
      for (const row of rows) {
        if (row.getAttribute('data-row-key') === 'session:' + sessionId) {
          return row.querySelector(':scope > span:last-child > span > button[aria-label]')
        }
      }
      return null
    }

    function SidebarForwardItem(props) {
      const t = translatorOf(props)
      const setMenuOpen = props.useMenuOpenState()[1]
      return h(MenuItemButton, {
        icon: ICON_FORWARD,
        onSelect: function () {
          const trigger = sidebarTrigger(props.sessionId)
          const token = ++operation
          setMenuOpen(false)
          // Let the host finish its own menu focus handoff before dialog autofocus.
          later(function () {
            if (!stale(token)) openDialog(props.sessionId, trigger, true)
          }, 0)
        },
      }, t('menu.forward'))
    }

    /* ================================================================
     * 7. React：错误边界 + 座位门控
     * ================================================================ */

    class DialogBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error: error }
      }

      componentDidCatch(error, info) {
        try {
          console.error('[session-forward] dialog render failed', error, info && info.componentStack)
        } catch (caught) {
          /* ignore */
        }
      }

      render() {
        if (this.state.error === null) return this.props.children
        const t = typeof this.props.t === 'function' ? this.props.t : bridge.t
        const detail = String(this.state.error && this.state.error.stack ? this.state.error.stack : this.state.error)
        return h('div', { className: 'dshsf-root', 'data-dsh-session-forward': 'dialog-error' },
          h('div', { className: 'dshsf-dialog', role: 'alertdialog', 'aria-modal': 'true' },
            h('div', { className: 'dshsf-head' },
              h('div', { className: 'dshsf-headText' },
                h('strong', { className: 'dshsf-title' }, t('title')),
                h('span', { className: 'dshsf-subtitle' }, t('error.render')),
              ),
              h('button', {
                type: 'button',
                className: 'dshsf-close',
                onClick: function () { closeDialog() },
                title: t('close'),
                'aria-label': t('close'),
              }, ICON_CLOSE),
            ),
            h('div', { className: 'dshsf-body' }, h('pre', { className: 'dshsf-pre' }, detail)),
          ),
        )
      }
    }

    /** 门控：只有 store.open 时才挂载弹窗，副作用随挂载/卸载自然起停 */
    function ForwardOverlay(props) {
      const state = useDialogState()
      if (state.open !== true) return null
      const t = translatorOf(props)
      let body
      if (typeof props.useWorkspaces === 'function') {
        body = h(WorkspaceAwareDialog, {
          state: state,
          t: t,
          useWorkspaces: props.useWorkspaces,
        })
      } else {
        body = h(DialogView, { state: state, t: t, workspaces: EMPTY_LIST })
      }
      return h(DialogBoundary, { t: t }, body)
    }

    /** 单独一层：useWorkspaces 是 hook 工厂，只能在组件顶层无条件调用 */
    function WorkspaceAwareDialog(props) {
      const snapshot = props.useWorkspaces(function (value) { return value })
      const workspaces = snapshot !== null && snapshot !== undefined && Array.isArray(snapshot.items)
        ? snapshot.items
        : EMPTY_LIST
      return h(DialogView, { state: props.state, t: props.t, workspaces: workspaces })
    }

    /* ================================================================
     * 8. React：弹窗本体
     * ================================================================ */

    function DialogView(props) {
      const state = props.state
      const t = props.t
      const workspaces = Array.isArray(props.workspaces) ? props.workspaces : EMPTY_LIST

      const dialogRef = React.useRef(null)
      const fileInputRef = React.useRef(null)

      // Esc 关闭（捕获阶段，避免与编辑器/输入框的 Esc 抢）
      React.useEffect(function () {
        const onKeyDown = function (event) {
          if (event.key !== 'Escape' && event.key !== 'Esc') return
          try {
            event.stopPropagation()
          } catch (error) {
            /* ignore */
          }
          closeDialog()
        }
        window.addEventListener('keydown', onKeyDown, true)
        return function () {
          window.removeEventListener('keydown', onKeyDown, true)
        }
      }, [])

      // 打开时把焦点放到对话框本身（不进入任何输入框），关闭时由 closeDialog 还回去
      React.useEffect(function () {
        const node = dialogRef.current
        if (node === null || typeof node.focus !== 'function') return undefined
        try {
          node.focus({ preventScroll: true })
        } catch (error) {
          try {
            node.focus()
          } catch (caught) {
            /* ignore */
          }
        }
        return undefined
      }, [])

      const busy = state.status === 'exporting' || state.status === 'importing'
      const result = isObject(state.result) ? state.result : null
      const summary = result !== null && isObject(result.summary) ? result.summary : null
      const importInfo = isObject(state.importInfo) ? state.importInfo : null
      const chosenWorkspaceId = selectedWorkspaceId(state, workspaces)

      const fire = function (promise) {
        try {
          Promise.resolve(promise).catch(function (error) {
            setDialog({ failure: failureOf('error.unexpected', null, messageOf(error)) })
          })
        } catch (error) {
          setDialog({ failure: failureOf('error.unexpected', null, messageOf(error)) })
        }
      }

      const onBackdropMouseDown = function (event) {
        let target = null
        let current = null
        try {
          target = event.target
          current = event.currentTarget
        } catch (error) {
          return
        }
        if (target !== null && current !== null && target === current) closeDialog()
      }

      const onChooseFile = function () {
        const input = fileInputRef.current
        if (input === null || input === undefined) return
        try {
          input.value = ''
        } catch (error) {
          /* ignore */
        }
        try {
          input.click()
        } catch (error) {
          setDialog({ failure: failureOf('error.picker', null, messageOf(error)) })
        }
      }

      const onFileChange = function (event) {
        let file = null
        try {
          const input = event && event.currentTarget ? event.currentTarget : null
          file = input !== null && input.files && input.files.length > 0 ? input.files[0] : null
        } catch (error) {
          file = null
        }
        if (file === null) return
        fire(runImport(file, chosenWorkspaceId))
      }

      /* ---------------- 转发分区 ---------------- */

      let exportBody
      if (state.status === 'exporting') {
        exportBody = h('div', { className: 'dshsf-status' },
          h('span', { className: 'dshsf-spinner', 'aria-hidden': 'true' }),
          h('span', null, t('export.preparing')),
        )
      } else if (result !== null) {
        const omittedParts = omittedTexts(summary, t)
        const messageCount = summary !== null && typeof summary.messages === 'number'
          ? summary.messages
          : (Array.isArray(result.bundle && result.bundle.messages) ? result.bundle.messages.length : 0)
        const title = summary !== null && typeof summary.title === 'string' && summary.title !== ''
          ? summary.title
          : ''
        exportBody = h('div', { className: 'dshsf-card' },
          h('div', { className: 'dshsf-cardTitle', title: title }, title === '' ? t('export.untitled') : title),
          h('div', { className: 'dshsf-meta' },
            h('div', { className: 'dshsf-metaRow' },
              h('span', { className: 'dshsf-metaValue' }, t('export.messages', { count: messageCount })),
            ),
            summary !== null && (typeof summary.userMessages === 'number' || typeof summary.assistantMessages === 'number')
              ? h('div', { className: 'dshsf-metaRow' },
                  h('span', { className: 'dshsf-metaValue' }, t('export.split', {
                    user: typeof summary.userMessages === 'number' ? summary.userMessages : 0,
                    assistant: typeof summary.assistantMessages === 'number' ? summary.assistantMessages : 0,
                  })),
                )
              : null,
            summary !== null && typeof summary.bytes === 'number'
              ? h('div', { className: 'dshsf-metaRow' },
                  h('span', { className: 'dshsf-metaValue' }, t('export.size', {
                    size: formatBytes(summary.bytes),
                    fileName: result.fileName,
                  })),
                )
              : null,
            omittedParts === null
              ? null
              : h('div', { className: 'dshsf-metaRow' },
                  h('span', { className: 'dshsf-metaValue' }, t('export.omitted', { parts: omittedParts })),
                ),
          ),
        )
      } else {
        exportBody = h('p', { className: 'dshsf-sectionHint' }, t('export.privacy'))
      }

      let exportActions
      if (state.status === 'exporting') {
        exportActions = null
      } else if (result !== null) {
        exportActions = [
          h('button', {
            key: 'share',
            type: 'button',
            className: 'dshsf-btn dshsf-btn-primary',
            onClick: function () { fire(copyShareLink()) },
            disabled: busy,
          }, t('action.share')),
          h('button', {
            key: 'save-html',
            type: 'button',
            className: 'dshsf-btn',
            onClick: function () { saveHtmlFile(t) },
            disabled: busy,
          }, t('action.saveHtml')),
          h('button', {
            key: 'save-bundle',
            type: 'button',
            className: 'dshsf-btn',
            onClick: function () { saveBundleFile() },
            disabled: busy,
          }, t('action.saveBundle')),
          h('button', {
            key: 'copy',
            type: 'button',
            className: 'dshsf-btn',
            onClick: function () { fire(copyMarkdown()) },
            disabled: busy,
          }, state.copyState === 'copied' ? t('action.copied') : t('action.copy')),
          h('button', {
            key: 'again',
            type: 'button',
            className: 'dshsf-btn',
            onClick: function () { fire(runExport()) },
            disabled: busy,
          }, t('action.again')),
        ]
      } else {
        exportActions = [
          h('button', {
            key: 'prepare',
            type: 'button',
            className: 'dshsf-btn dshsf-btn-primary',
            onClick: function () { fire(runExport()) },
            disabled: busy,
          }, t('action.prepare')),
        ]
      }

      let shareBlock = null
      if (state.share !== null) {
        const expiresAt = formatShareExpiry(state.share.expiresAt)
        shareBlock = h('div', { className: 'dshsf-share' },
          h('input', {
            className: 'dshsf-shareUrl',
            type: 'text',
            readOnly: true,
            value: state.share.url,
            'aria-label': t('share.urlLabel'),
            onFocus: function (event) {
              try {
                event.currentTarget.select()
              } catch (error) {
                /* ignore */
              }
            },
            onClick: function (event) {
              try {
                event.currentTarget.select()
              } catch (error) {
                /* ignore */
              }
            },
          }),
          h('button', {
            type: 'button',
            className: 'dshsf-btn',
            onClick: function () { fire(copyShareUrl()) },
            disabled: busy,
          }, t('action.shareCopy')),
          h('p', { className: 'dshsf-shareHint' },
            expiresAt === '' ? t('share.hint') : t('share.hintExpires', { at: expiresAt }),
          ),
        )
      }

      /* ---------------- 导入分区 ---------------- */

      const workspaceOptions = workspaces.map(function (workspace) {
        const id = workspaceIdOf(workspace)
        if (id === '') return null
        const label = workspaceTitleOf(workspace)
        const suffix = containsSession(workspace, state.sessionId) ? ' · ' + t('workspace.currentTag') : ''
        return h('option', { key: id, value: id }, label + suffix)
      })

      let importBody
      if (state.status === 'importing') {
        importBody = h('div', { className: 'dshsf-status' },
          h('span', { className: 'dshsf-spinner', 'aria-hidden': 'true' }),
          h('span', null, t('import.importing')),
        )
      } else if (importInfo !== null) {
        importBody = h('div', { className: 'dshsf-card' },
          h('div', { className: 'dshsf-cardTitle', title: importInfo.title },
            importInfo.title === '' ? t('import.doneNoTitle') : importInfo.title),
          h('div', { className: 'dshsf-meta' },
            h('div', { className: 'dshsf-metaRow' },
              h('span', { className: 'dshsf-metaValue' },
                t('import.summary', { count: importInfo.messages === undefined ? 0 : importInfo.messages })),
            ),
          ),
          h('div', { className: 'dshsf-actions' },
            h('button', {
              type: 'button',
              className: 'dshsf-btn',
              onClick: function () { fire(retryOpenImported()) },
              disabled: busy,
            }, t('action.open')),
          ),
        )
      } else {
        importBody = h('p', { className: 'dshsf-sectionHint' }, t('section.importHint'))
      }

      const workspaceField = h('div', { className: 'dshsf-field' },
        h('label', { className: 'dshsf-label', htmlFor: 'dshsf-workspace' }, t('field.workspace')),
        h('select', {
          id: 'dshsf-workspace',
          className: 'dshsf-select',
          value: chosenWorkspaceId,
          disabled: busy,
          onChange: function (event) {
            let value = ''
            try {
              value = event && event.currentTarget ? String(event.currentTarget.value) : ''
            } catch (error) {
              value = ''
            }
            setDialog({ workspaceChoice: value })
          },
        },
          h('option', { value: '' }, t('workspace.default')),
          workspaceOptions,
        ),
        h('span', { className: 'dshsf-sectionHint' }, t('field.workspaceHint')),
      )

      const failureMessage = failureText(state.failure, t)
      const successMessage = noticeText(state.notice, t)
      const hasFooter = failureMessage !== '' || successMessage !== ''

      return h('div', {
        className: 'dshsf-root',
        'data-dsh-session-forward': 'dialog',
        onMouseDown: onBackdropMouseDown,
      },
        h('div', {
          ref: dialogRef,
          className: 'dshsf-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': DIALOG_TITLE_ID,
          tabIndex: -1,
          onMouseDown: function (event) {
            try {
              event.stopPropagation()
            } catch (error) {
              /* ignore */
            }
          },
        },
          h('div', { className: 'dshsf-head' },
            h('div', { className: 'dshsf-headText' },
              h('strong', { className: 'dshsf-title', id: DIALOG_TITLE_ID }, t('title')),
              h('span', { className: 'dshsf-subtitle' }, t('subtitle')),
            ),
            h('button', {
              type: 'button',
              className: 'dshsf-close',
              onClick: function () { closeDialog() },
              title: t('closeHint'),
              'aria-label': t('close'),
            }, ICON_CLOSE),
          ),

          h('div', { className: 'dshsf-body' },
            h('section', { className: 'dshsf-section', 'data-dshsf-section': 'export' },
              h('div', { className: 'dshsf-sectionTitle' }, t('section.export')),
              h('p', { className: 'dshsf-sectionHint' }, t('section.exportHint')),
              exportBody,
              exportActions === null ? null : h('div', { className: 'dshsf-actions' }, exportActions),
              shareBlock,
            ),

            h('section', { className: 'dshsf-section', 'data-dshsf-section': 'import' },
              h('div', { className: 'dshsf-sectionTitle' }, t('section.import')),
              workspaceField,
              importBody,
              h('input', {
                ref: fileInputRef,
                type: 'file',
                accept: FILE_ACCEPT,
                className: 'dshsf-sr',
                tabIndex: -1,
                'aria-label': t('a11y.fileInput'),
                onChange: onFileChange,
              }),
              h('div', { className: 'dshsf-actions' },
                h('button', {
                  type: 'button',
                  className: 'dshsf-btn dshsf-btn-primary',
                  onClick: onChooseFile,
                  disabled: busy,
                }, t('action.choose')),
              ),
            ),
          ),

          hasFooter
            ? h('div', { className: 'dshsf-foot' },
                failureMessage === ''
                  ? null
                  : h('div', { className: 'dshsf-failure', role: 'alert' }, failureMessage),
                successMessage === ''
                  ? null
                  : h('div', { className: 'dshsf-notice', role: 'status' }, successMessage),
              )
            : null,
        ),
      )
    }

    /** 把 summary.omitted 拼成一句「已省略 …」；没有省略项时返回 null */
    function omittedTexts(summary, t) {
      if (summary === null || summary === undefined) return null
      const omitted = summary.omitted
      if (!isObject(omitted)) return null
      const parts = []
      const rows = [
        ['toolCalls', 'export.omit.toolCalls'],
        ['toolResults', 'export.omit.toolResults'],
        ['reasoning', 'export.omit.reasoning'],
        ['images', 'export.omit.images'],
        ['files', 'export.omit.files'],
      ]
      for (let index = 0; index < rows.length; index += 1) {
        const value = omitted[rows[index][0]]
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
          parts.push(t(rows[index][1], { count: value }))
        }
      }
      // Host 侧 omitted.truncated 存的是「被截断的条数」（数字），这里兼容布尔写法
      const truncated = omitted.truncated
      if (truncated === true || (typeof truncated === 'number' && Number.isFinite(truncated) && truncated > 0)) {
        parts.push(t('export.omit.truncated'))
      }
      return parts.length === 0 ? null : parts.join(' · ')
    }

    /* ================================================================
     * 9. 样式（只用 --dsw-alias-* / --dsw-radius-* / --dsw-elevation-* 主题 token）
     * ================================================================ */

    const CSS = [
      '.dshsf-trigger{display:inline-flex;align-items:center;justify-content:center;',
      'width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-md);',
      'background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;flex:none;',
      'transition:color .12s,background-color .12s}',
      '.dshsf-trigger:hover,.dshsf-trigger:focus-visible{color:var(--dsw-alias-label-primary);',
      'background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshsf-trigger:focus-visible{outline:var(--dsw-focus-ring-width) solid ',
      'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}',
      '.dshsf-triggerIcon{display:inline-flex;align-items:center;justify-content:center;transform:rotate(-90deg)}',

      '.dshsf-root{position:fixed;inset:0;z-index:30;display:flex;align-items:center;',
      'justify-content:center;padding:24px;box-sizing:border-box;',
      'background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur,blur(6px));',
      'pointer-events:auto;-webkit-app-region:no-drag;font-size:13px;line-height:20px}',

      '.dshsf-dialog{display:flex;flex-direction:column;width:min(560px,100%);',
      'max-height:min(680px,calc(100vh - 48px));border-radius:var(--dsw-radius-panel);',
      'background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);',
      'color:var(--dsw-alias-label-primary);overflow:hidden;outline:none}',

      '.dshsf-head{display:flex;align-items:flex-start;gap:12px;flex:none;',
      'padding:16px 18px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.dshsf-headText{display:flex;flex-direction:column;gap:3px;flex:1 1 auto;min-width:0}',
      '.dshsf-title{font-size:15px;line-height:22px;font-weight:600;margin:0}',
      '.dshsf-subtitle{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.dshsf-close{display:inline-flex;align-items:center;justify-content:center;',
      'width:26px;height:26px;flex:none;margin:-2px -4px 0 0;padding:0;border:0;',
      'border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer;',
      'color:var(--dsw-alias-label-tertiary);transition:color .12s,background-color .12s}',
      '.dshsf-close:hover,.dshsf-close:focus-visible{color:var(--dsw-alias-label-primary);',
      'background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshsf-close:focus-visible{outline:var(--dsw-focus-ring-width) solid ',
      'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}',

      '.dshsf-body{display:flex;flex-direction:column;gap:18px;min-height:0;overflow-y:auto;',
      'padding:16px 18px 18px;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);',
      '--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}',
      '.dshsf-section{display:flex;flex-direction:column;gap:10px}',
      '.dshsf-section+.dshsf-section{border-top:.5px solid var(--dsw-alias-border-l1);padding-top:18px}',
      '.dshsf-sectionTitle{font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dshsf-sectionHint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin:0}',
      '.dshsf-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',

      '.dshsf-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;',
      'height:28px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l3);',
      'border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);',
      'font-size:12px;line-height:1;cursor:pointer;',
      'transition:background-color .12s,color .12s,border-color .12s}',
      '.dshsf-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshsf-btn:disabled{color:var(--dsw-alias-label-dimmed);cursor:default;opacity:.6}',
      '.dshsf-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid ',
      'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.dshsf-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;',
      'color:var(--dsw-alias-label-primary-foreground)}',
      '.dshsf-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',

      '.dshsf-card{display:flex;flex-direction:column;gap:6px;padding:10px 12px;',
      'border-radius:var(--dsw-radius-lg);box-shadow:0 0 0 .5px var(--dsw-alias-border-l2);',
      'background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1))}',
      '.dshsf-cardTitle{font-size:13px;line-height:20px;font-weight:600;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshsf-meta{display:flex;flex-direction:column;gap:2px;font-size:12px;line-height:18px;',
      'color:var(--dsw-alias-label-tertiary)}',
      '.dshsf-metaRow{display:flex;gap:6px;min-width:0}',
      '.dshsf-metaValue{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      'color:var(--dsw-alias-label-secondary)}',

      '.dshsf-field{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.dshsf-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dshsf-select{box-sizing:border-box;height:30px;max-width:100%;padding:0 8px;font-size:12px;',
      'border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);',
      'background:var(--dsw-alias-button-elevated-fill,var(--dsw-alias-bg-layer-1));',
      'color:var(--dsw-alias-label-primary);outline:none}',
      '.dshsf-select:disabled{color:var(--dsw-alias-label-dimmed)}',
      '.dshsf-select:focus-visible{outline:var(--dsw-focus-ring-width) solid ',
      'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',

      '.dshsf-status{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;',
      'color:var(--dsw-alias-label-secondary)}',
      '.dshsf-spinner{display:inline-block;flex:none;width:13px;height:13px;border-radius:50%;',
      'border:1.5px solid var(--dsw-alias-border-l3);',
      'border-top-color:var(--dsw-alias-state-business-primary);',
      'animation:dshsf-spin .8s linear infinite}',
      '@keyframes dshsf-spin{to{transform:rotate(360deg)}}',

      '.dshsf-foot{display:flex;flex-direction:column;gap:6px;flex:none;padding:0 18px 14px}',
      '.dshsf-failure,.dshsf-notice{font-size:12px;line-height:18px;padding:8px 10px;',
      'border-radius:var(--dsw-radius-md);overflow-wrap:anywhere}',
      '.dshsf-failure{color:var(--dsw-alias-state-error-primary);',
      'background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}',
      '.dshsf-notice{color:var(--dsw-alias-state-success-primary);',
      'background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}',

      '.dshsf-pre{margin:0;max-height:200px;overflow:auto;font-size:11px;line-height:16px;',
      'white-space:pre-wrap;color:var(--dsw-alias-label-tertiary);',
      'font-family:var(--ds-font-family-code)}',
      '.dshsf-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;',
      'clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}',

      '.dshsf-share{margin-top:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);',
      'border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-l1)}',
      '.dshsf-shareUrl{width:100%;box-sizing:border-box;font:12px/1.6 var(--ds-font-family-code);',
      'padding:6px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);',
      'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.dshsf-shareHint{margin:8px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',

      '@media (prefers-reduced-motion:reduce){.dshsf-spinner{animation:none}',
      '.dshsf-trigger,.dshsf-close,.dshsf-btn{transition:none}}',
    ].join('')

    /* ================================================================
     * 10. 文案（zh + en；键名带点，插值用 {name}）
     * ================================================================ */

    const dict = {
      zh: {
        open: '会话转发',
        'menu.forward': '转发',
        title: '会话转发',
        subtitle: '把这段对话交给别人，或者打开别人转发的对话。',
        close: '关闭',
        closeHint: 'Esc 也可以关闭',

        'section.export': '转发本会话',
        'section.exportHint': '导出成一个网页文件：对方双击就能读，不用装任何东西。',
        'section.import': '打开别人转发的会话',
        'section.importHint': '选择对方发来的 .dshchat 文件，还原成一条可以继续聊的会话（需要双方都装了本插件）。',

        'action.prepare': '准备转发文件',
        'action.share': '复制分享链接（对方零安装）',
        'action.shareCopy': '再复制一次',
        'action.saveHtml': '保存网页记录',
        'action.saveBundle': '保存会话文件（.dshchat）',
        'action.copy': '复制 Markdown',
        'action.copied': '已复制',
        'action.again': '重新准备',
        'action.choose': '选择 .dshchat 文件',
        'action.open': '再试一次打开',

        'export.preparing': '正在整理对话…',
        'export.ready': '转发文件已就绪',
        'export.untitled': '未命名会话',
        'export.messages': '{count} 条消息',
        'export.split': '{user} 条来自你 · {assistant} 条来自助手',
        'export.size': '{size} · {fileName}',
        'export.privacy': '只带走对话文字；工具调用、推理过程和附件不会跟着转发。',
        'export.omitted': '已省略 {parts}',
        'export.omit.toolCalls': '{count} 个工具调用',
        'export.omit.toolResults': '{count} 个工具结果',
        'export.omit.reasoning': '{count} 段推理',
        'export.omit.images': '{count} 张图片',
        'export.omit.files': '{count} 个附件',
        'export.omit.truncated': '部分超长消息被截断',

        'copy.done': 'Markdown 已复制到剪贴板',
        'save.done': '文件已交给浏览器保存：{fileName}',
        'save.htmlDone': '网页记录已保存：{fileName}',

        'share.done': '分享链接已复制，直接粘到微信/飞书就行',
        'share.copyManually': '链接已生成，请手动复制下面的地址',
        'share.urlLabel': '分享链接',
        'share.hint': '链接 24 小时有效；对方需要和你连同一个 Wi-Fi/局域网。异地的对方打不开时，用「保存网页记录」发文件。',
        'share.hintExpires': '有效期到 {at}；对方需要和你连同一个 Wi-Fi/局域网。异地的对方打不开时，用「保存网页记录」发文件。',

        'html.meta': '转发自 DSH · {when} · {count} 条消息',
        'html.note': '这是一段从 DSH 会话里导出的对话记录。双击文件即可阅读，不需要安装任何东西；页面底部的按钮可以把全文复制成 Markdown。',
        'html.user': '我',
        'html.assistant': '助手',
        'html.copy': '复制全文（Markdown）',
        'html.copied': '已复制',
        'html.footer': '由 DeepSeek Harness · 会话转发生成',
        'html.source': '来源会话：{session}',

        'import.importing': '正在打开转发的对话…',
        'import.done': '已打开「{title}」',
        'import.doneNoTitle': '已打开转发的对话',
        'import.summary': '{count} 条消息 · 新会话',

        'field.workspace': '放到哪里',
        'field.workspaceHint': '「默认位置」会跟着文件里记录的目录走。',
        'workspace.default': '默认位置',
        'workspace.currentTag': '当前会话所在位置',

        'error.noSession': '拿不到当前会话的 id，请关掉弹窗重新打开。',
        'error.badResponse': '服务器返回了无法解析的响应（HTTP {status}）。',
        'error.exportFailed': '导出失败了。',
        'error.importFailed': '导入失败了。',
        'error.network': '请求没有发出去。',
        'error.readFile': '读不了这个文件。',
        'error.parse': '这不是合法的 JSON 文件。',
        'error.format': '这不是 DSH 会话转发文件（format 不是 dsh-session-forward）。',
        'error.open': '会话已经导入，但没能自动打开；它已经在侧栏里了。',
        'error.openUnavailable': '这个 DSH 版本没有提供打开会话的接口；会话已经导入。',
        'error.copy': '复制失败了，可能没有剪贴板权限。',
        'error.save': '保存文件失败了。',
        'error.picker': '打不开文件选择器。',
        'error.detail': '（{message}）',
        'error.shareFailed': '没能生成分享链接。',
        'error.restartRequired': '这个 DSH 进程还没加载新的 Host 代码，请重启 DSH 后再试。',
        'error.unexpected': '出了点意外。',
        'error.render': '弹窗渲染出错了。',

        'a11y.fileInput': '选择 .dshchat 文件',
      },
      en: {
        open: 'Forward this session',
        'menu.forward': 'Forward',
        title: 'Session forwarding',
        subtitle: 'Hand this conversation to someone else, or open a conversation they forwarded to you.',
        close: 'Close',
        closeHint: 'Esc also closes',

        'section.export': 'Forward this session',
        'section.exportHint': 'Export a single web page: whoever receives it just double-clicks to read, nothing to install.',
        'section.import': 'Open a forwarded session',
        'section.importHint': 'Pick a .dshchat file someone sent you; it becomes a real session you can keep chatting in (both sides need this plugin).',

        'action.prepare': 'Prepare forwarding file',
        'action.share': 'Copy share link (nothing to install)',
        'action.shareCopy': 'Copy again',
        'action.saveHtml': 'Save web page',
        'action.saveBundle': 'Save session file (.dshchat)',
        'action.copy': 'Copy as Markdown',
        'action.copied': 'Copied',
        'action.again': 'Prepare again',
        'action.choose': 'Choose a .dshchat file',
        'action.open': 'Try opening again',

        'export.preparing': 'Preparing the conversation…',
        'export.ready': 'The forwarding file is ready',
        'export.untitled': 'Untitled session',
        'export.messages': '{count} messages',
        'export.split': '{user} from you · {assistant} from the assistant',
        'export.size': '{size} · {fileName}',
        'export.privacy': 'Only the conversation text travels; tool calls, reasoning and attachments stay behind.',
        'export.omitted': 'Left out: {parts}',
        'export.omit.toolCalls': '{count} tool calls',
        'export.omit.toolResults': '{count} tool results',
        'export.omit.reasoning': '{count} reasoning blocks',
        'export.omit.images': '{count} images',
        'export.omit.files': '{count} attachments',
        'export.omit.truncated': 'some very long messages were truncated',

        'copy.done': 'Markdown copied to the clipboard',
        'save.done': 'The browser is saving the file: {fileName}',
        'save.htmlDone': 'Saved the web page: {fileName}',

        'share.done': 'Share link copied — paste it into WeChat, Feishu, anywhere',
        'share.copyManually': 'Link created; copy the address below manually',
        'share.urlLabel': 'Share link',
        'share.hint': 'The link works for 24 hours for someone on the same Wi-Fi/LAN. If they are elsewhere, use “Save web page” and send the file instead.',
        'share.hintExpires': 'Valid until {at} for someone on the same Wi-Fi/LAN. If they are elsewhere, use “Save web page” and send the file instead.',

        'html.meta': 'Forwarded from DSH · {when} · {count} messages',
        'html.note': 'A conversation record exported from a DSH session. Double-click the file to read it — nothing to install. The button at the bottom copies the whole text as Markdown.',
        'html.user': 'Me',
        'html.assistant': 'Assistant',
        'html.copy': 'Copy full text (Markdown)',
        'html.copied': 'Copied',
        'html.footer': 'Generated by DeepSeek Harness · Session forwarding',
        'html.source': 'Source session: {session}',

        'import.importing': 'Opening the forwarded conversation…',
        'import.done': 'Opened “{title}”',
        'import.doneNoTitle': 'Opened the forwarded conversation',
        'import.summary': '{count} messages · new session',

        'field.workspace': 'Where to put it',
        'field.workspaceHint': '“Default location” follows the directory recorded in the file.',
        'workspace.default': 'Default location',
        'workspace.currentTag': "current session's place",

        'error.noSession': 'Could not read the current session id; close the dialog and open it again.',
        'error.badResponse': 'The server returned an unreadable response (HTTP {status}).',
        'error.exportFailed': 'Export failed.',
        'error.importFailed': 'Import failed.',
        'error.network': 'The request did not go through.',
        'error.readFile': 'Could not read that file.',
        'error.parse': 'That file is not valid JSON.',
        'error.format': 'That is not a DSH forwarding file (format is not dsh-session-forward).',
        'error.open': 'The session was imported but could not be opened automatically; it is in the sidebar.',
        'error.openUnavailable': 'This DSH build exposes no way to open a session; the session was imported.',
        'error.copy': 'Copy failed; the clipboard may be denied.',
        'error.save': 'Saving the file failed.',
        'error.picker': 'Could not open the file picker.',
        'error.detail': '({message})',
        'error.shareFailed': 'Could not create a share link.',
        'error.restartRequired': 'This DSH process has not loaded the new host code yet — restart DSH and try again.',
        'error.unexpected': 'Something went wrong.',
        'error.render': 'The dialog failed to render.',

        'a11y.fileInput': 'Choose a .dshchat file',
      },
    }

    /* ================================================================
     * 11. 插件入口
     * ================================================================ */

    const inject = ['slots', 'locale']

    function apply(ctx) {
      disposed = false
      operation += 1
      bridge.ctx = ctx

      // 词典：注册失败（例如热重载时命名空间已存在）不应该让整个插件挂掉
      ctx.effect(function () {
        try {
          return ctx.locale.register(NS, dict)
        } catch (error) {
          if (typeof console !== 'undefined') console.warn('[' + NS + '] locale registration failed', error)
          return function () {}
        }
      }, PKG + ': dictionaries')

      try {
        bridge.t = ctx.locale.bind(NS)
      } catch (error) {
        bridge.t = function (key) { return key }
      }

      // 样式表：随插件生命周期挂载/移除，key 用 data-plugin-css 去重
      ctx.effect(function () {
        const tagId = PKG + '/client.css'
        const selector = 'style[data-plugin-css="' + tagId + '"]'
        if (document.querySelector(selector) !== null) return function () {}
        const style = document.createElement('style')
        style.dataset.plugin = PKG
        style.dataset.pluginCss = tagId
        style.textContent = CSS
        document.head.appendChild(style)
        return function () {
          if (style.parentNode !== null) style.parentNode.removeChild(style)
        }
      }, PKG + ': styles')

      // 定时器 + store 订阅都挂在这里，插件卸载时一次清干净
      ctx.effect(function () {
        return function () {
          disposed = true
          disposeTimers()
          dialogSubs.clear()
          dialogState = INITIAL_STATE
          returnFocusElement = null
          returnFocusToHeader = false
          bridge.ctx = null
        }
      }, PKG + ': teardown')

      // 页头：图标按钮（session 作用域，能拿到 sessionId）
      ctx.slots.inject('conversation.session.header.utilities', function () {
        return ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'session-forward',
          order: 300,
          locale: NS,
          label: function () { return bridge.t('open') },
        }, ForwardTrigger)
      })

      // 侧栏菜单：使用行自己的 sessionId，不切换当前会话。
      ctx.slots.inject('sidebar.workspaces.session.menu.item', function () {
        return ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'session-forward.menu',
          order: 500,
          locale: NS,
          label: function () { return bridge.t('menu.forward') },
        }, SidebarForwardItem)
      })

      // 全屏浮层：root 作用域 list 座位，默认点透，只有打开时才挂载
      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-forward.dialog',
          order: 200,
          locale: NS,
          label: function () { return bridge.t('title') },
        }, ForwardOverlay)
      })
    }

    const exported = { isPlugin: true, inject: inject, apply: apply }

    return exported
  },
})
