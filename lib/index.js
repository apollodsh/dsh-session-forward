/**
 * dsh-session-forward · Host 半边
 *
 * 两个能力，共用同一套纯逻辑（lib/transcript.js）：
 *   导出：读当前/指定会话的「当前 surface」→ 打包成 .dshchat.json（Connection 精确 Fetch 路由，只允许 owner）
 *   导入：校验 bundle → 用 sessionController.create 建一条真实的新会话 → 追加标准
 *         turn/step/message 事件 → 设标题 → flush，得到一条持久、可继续聊的会话
 *
 * 分享：把同一段对话渲染成自包含网页，由插件自带的临时 HTTP 服务在局域网内提供，
 *       返回一个 24 小时有效的链接，直接粘到微信/飞书就能发给没装插件的人。
 *
 * 另外注册一个 agent 工具 session_forward（export/import/share），
 * 让模型也能触发同一套操作：UI 与工具调用同一份实现，不各写一套。
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { extname, isAbsolute, join } from 'node:path'

import { renderHtmlDocument, suggestHtmlFileName } from './html.js'
import { createShareStore, pickLanAddresses, startShareServer } from './share.js'
import {
  MAX_BUNDLE_BYTES,
  buildBundle,
  buildSessionEvents,
  bundleToMarkdown,
  extractTranscript,
  suggestFileName,
  validateBundle,
} from './transcript.js'

// 这些服务在 Web profile 里随 dsh-base / dsh-web-app 一起挂载；缺任何一个插件就不激活，
// 而不是在 apply 里抛错影响整个 Host。
export const inject = ['sessions', 'sessionQuery', 'sessionController']

const ROUTE_EXPORT = '/api/session-forward.export'
const ROUTE_IMPORT = '/api/session-forward.import'
const ROUTE_SHARE = '/api/session-forward.share'
const TOOL_NAME = 'session_forward'

/** 分享链接默认 24 小时有效；最多同时保留 50 份，过期自动清理 */
const SHARE_TTL_MS = 24 * 60 * 60 * 1000
const SHARE_MAX_ENTRIES = 50
const SHARE_SWEEP_MS = 5 * 60 * 1000

/** 标题在 session-title 服务里的字节上限（默认配置 maxTitleBytes=120），这里留一点余量 */
const TITLE_MAX_BYTES = 112

export function apply(ctx) {
  // 分享服务只在第一次创建链接时启动，插件卸载时一起关掉。
  const shares = { store: null, server: null, starting: null, timer: null }

  ctx.effect(() => () => {
    if (shares.timer !== null) {
      clearInterval(shares.timer)
      shares.timer = null
    }
    const server = shares.server
    shares.server = null
    if (server !== null) void server.close()
  }, 'session-forward: share server teardown')

  ctx.inject(['connection'], (scoped) => {
    scoped.effect(() => scoped.connection.fetch.register({
      path: ROUTE_EXPORT,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) => handleExportRequest(ctx, request),
    }), 'session-forward: exact Fetch route /api/session-forward.export')

    scoped.effect(() => scoped.connection.fetch.register({
      path: ROUTE_IMPORT,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleImportRequest(ctx, request),
    }), 'session-forward: exact Fetch route /api/session-forward.import')

    scoped.effect(() => scoped.connection.fetch.register({
      path: ROUTE_SHARE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleShareRequest(ctx, shares, request),
    }), 'session-forward: exact Fetch route /api/session-forward.share')
  })

  ctx.inject(['tools'], (scoped) => {
    scoped.effect(() => scoped.tools.register({
      name: TOOL_NAME,
      description: [
        'Forward a DSH conversation between people as a portable .dshchat file.',
        'action="export" writes the current (or named) session as a .dshchat JSON file that can be sent to someone else.',
        'action="import" opens such a file as a new, resumable session in this DSH and returns its session id.',
        'action="share" publishes a self-contained web page served by this machine and returns a link valid for 24 hours; send that link to someone who has no plugin (reachable on the same local network).',
        'Only the visible conversation is carried over: reasoning, tool calls, tool results and attachments are left out.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['export', 'import', 'share'],
            description: 'export writes a forwarding file; import opens one as a new session; share returns a temporary LAN link to a web page.',
          },
          path: {
            type: 'string',
            description: 'Absolute file path. Required for import; for export it is the destination file (or directory) and defaults to the session workspace.',
          },
          sessionId: {
            type: 'string',
            description: 'Session to export. Defaults to the calling session.',
          },
          workspaceId: {
            type: 'string',
            description: 'Workspace that should own the imported session. Defaults to the workspace matching the DSH default directory.',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            path: { type: 'string' },
            sessionId: { type: 'string' },
            title: { type: 'string' },
            messages: { type: 'number' },
            url: { type: 'string' },
            expiresAt: { type: 'number' },
          },
          required: ['ok'],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: describeToolValue(value) }],
      },
      execute: (args, exec) => runTool(ctx, shares, args, exec),
    }), 'session-forward: session_forward tool')
  })
}

/* ================================================================
 * HTTP 路由
 * ================================================================ */

async function handleExportRequest(ctx, request) {
  try {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('sessionId')
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return json(400, { ok: false, error: '缺少 sessionId 参数' })
    }
    const result = await exportSession(ctx, sessionId.trim())
    return json(200, { ok: true, ...result })
  } catch (error) {
    return failureResponse(ctx, 'export', error)
  }
}

async function handleImportRequest(ctx, request) {
  try {
    if (!isJsonContentType(request.headers.get('content-type'))) {
      return json(415, { ok: false, error: '请求体必须是 application/json' })
    }
    const declaredBytes = Number(request.headers.get('content-length'))
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_BUNDLE_BYTES) {
      return json(413, { ok: false, error: `转发文件超过 ${Math.round(MAX_BUNDLE_BYTES / 1024 / 1024)} MiB 上限` })
    }
    const raw = await request.text()
    if (Buffer.byteLength(raw, 'utf8') > MAX_BUNDLE_BYTES) {
      return json(413, { ok: false, error: `转发文件超过 ${Math.round(MAX_BUNDLE_BYTES / 1024 / 1024)} MiB 上限` })
    }
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      return json(400, { ok: false, error: '请求体不是合法 JSON' })
    }
    if (body == null || typeof body !== 'object') {
      return json(400, { ok: false, error: '请求体格式非法' })
    }
    const result = await importBundle(ctx, body.bundle ?? body, {
      workspaceId: typeof body.workspaceId === 'string' && body.workspaceId !== '' ? body.workspaceId : undefined,
    })
    return json(200, { ok: true, ...result })
  } catch (error) {
    return failureResponse(ctx, 'import', error)
  }
}

async function handleShareRequest(ctx, shares, request) {
  try {
    if (!isJsonContentType(request.headers.get('content-type'))) {
      return json(415, { ok: false, error: '请求体必须是 application/json' })
    }
    const raw = await request.text()
    if (Buffer.byteLength(raw, 'utf8') > 64 * 1024) {
      return json(413, { ok: false, error: '请求体过大' })
    }
    let body
    try {
      body = raw === '' ? {} : JSON.parse(raw)
    } catch {
      return json(400, { ok: false, error: '请求体不是合法 JSON' })
    }
    if (body === null || typeof body !== 'object') {
      return json(400, { ok: false, error: '请求体格式非法' })
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (sessionId === '' || !isPlausibleSessionId(sessionId)) {
      return json(400, { ok: false, error: '缺少合法的 sessionId 参数' })
    }
    const hours = Number.isFinite(body.hours) ? body.hours : undefined
    const result = await createShare(ctx, shares, sessionId, hours === undefined
      ? {}
      : { ttlMs: Math.min(Math.max(hours, 1), 168) * 60 * 60 * 1000 })
    return json(200, { ok: true, ...result })
  } catch (error) {
    return failureResponse(ctx, 'share', error)
  }
}

/**
 * 创建一条分享链接：渲染网页 → 存进内存 → 返回局域网地址。
 * 分享服务在第一次调用时才监听端口，插件卸载时关闭。
 */
async function createShare(ctx, shares, sessionId, options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : SHARE_TTL_MS
  const exported = await exportSession(ctx, sessionId)
  const addresses = pickLanAddresses()
  if (addresses.length === 0) {
    throw new ForwardError(409, '这台电脑没有可用的局域网地址，先保存网页记录再手动转发吧')
  }
  const server = await ensureShareServer(ctx, shares)
  const expiresAt = Date.now() + ttlMs
  const html = renderHtmlDocument({
    bundle: exported.bundle,
    markdown: exported.markdown,
    title: exported.summary.title,
    sessionId,
    expiresAt,
  })
  const stored = shares.store.put(html, { sessionId, title: exported.summary.title })
  const urls = addresses.map((item) => `http://${urlHost(item.address)}:${server.port}/s/${stored.token}`)
  return {
    url: urls[0],
    urls,
    port: server.port,
    expiresAt: stored.expiresAt,
    title: exported.summary.title,
    messages: exported.summary.messages,
  }
}

async function ensureShareServer(ctx, shares) {
  if (shares.server !== null) return shares.server
  if (shares.starting !== null) return shares.starting
  shares.starting = (async () => {
    if (shares.store === null) {
      shares.store = createShareStore({ ttlMs: SHARE_TTL_MS, maxEntries: SHARE_MAX_ENTRIES })
    }
    const server = await startShareServer({
      store: shares.store,
      bindHost: '0.0.0.0',
      port: 0,
      logger: ctx.logger,
    })
    shares.server = server
    if (shares.timer === null) {
      shares.timer = setInterval(() => {
        try {
          shares.store.sweep()
        } catch {
          /* 清理失败不影响分享 */
        }
      }, SHARE_SWEEP_MS)
      if (typeof shares.timer.unref === 'function') shares.timer.unref()
    }
    return server
  })()
  try {
    return await shares.starting
  } finally {
    shares.starting = null
  }
}

/** 局域网上取到的地址可能是 IPv6，URL 里要加方括号 */
function urlHost(address) {
  return typeof address === 'string' && address.includes(':') ? `[${address}]` : String(address)
}

function failureResponse(ctx, operation, error) {
  const status = error instanceof ForwardError ? error.status : 500
  const detail = error instanceof Error ? error.message : String(error)
  if (status >= 500) {
    // 500 只把可读结论回给浏览器，内部异常细节（可能含绝对路径）进 Host 日志。
    ctx.logger?.warn?.(`session-forward: ${operation} failed: ${detail}`)
    return json(status, { ok: false, error: `内部错误：${operation} 失败，详情见 DSH 日志` })
  }
  return json(status, { ok: false, error: detail })
}

function isJsonContentType(value) {
  if (typeof value !== 'string') return false
  const mediaType = value.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  return mediaType === 'application/json' || (mediaType.startsWith('application/') && mediaType.endsWith('+json'))
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

class ForwardError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'ForwardError'
    this.status = status
  }
}

/* ================================================================
 * 导出
 * ================================================================ */

async function exportSession(ctx, sessionId) {
  const live = ctx.sessions.get(sessionId)
  if (live !== undefined) {
    // 导出必须是「此刻完整」的日志：先走一次持久性屏障，再读 surface。
    try {
      await ctx.sessions.flush(live)
    } catch (error) {
      ctx.logger?.warn?.(`session-forward: flush before export failed: ${String(error)}`)
    }
  }

  let surface
  try {
    surface = await ctx.sessionQuery.readSurface(sessionId)
  } catch (error) {
    throw new ForwardError(404, `读不到会话 ${sessionId}：${error instanceof Error ? error.message : String(error)}`)
  }

  const { messages, stats } = extractTranscript(surface.events)
  if (messages.length === 0) {
    throw new ForwardError(400, '这个会话里还没有可以转发的对话内容')
  }

  let title
  try {
    title = (await ctx.sessionQuery.readTitle(sessionId))?.title
  } catch {
    title = undefined
  }

  const model = lastAssistantModel(surface.events)
  const header = surface.session ?? {}
  const bundle = buildBundle({
    messages,
    stats,
    session: {
      // 不写 session id：它指向发送方机器上的一条真实日志，对收件人无用。
      title: typeof title === 'string' ? sanitizeTitle(title) : undefined,
      cwd: typeof header.cwd === 'string' ? maskHomePath(header.cwd) : undefined,
      createdAt: typeof header.createdAt === 'number' ? header.createdAt : undefined,
      provider: model?.provider,
      model: model?.model,
    },
    now: Date.now(),
  })
  const markdown = bundleToMarkdown(bundle)
  const fileName = suggestFileName(bundle.session.title)
  const htmlFileName = suggestHtmlFileName(bundle.session.title)
  const html = renderHtmlDocument({ bundle, markdown, title: bundle.session.title, sessionId })

  return {
    fileName,
    htmlFileName,
    html,
    bundle,
    markdown,
    summary: {
      title: bundle.session.title,
      messages: bundle.session.messageCount,
      userMessages: bundle.session.userMessages,
      assistantMessages: bundle.session.assistantMessages,
      omitted: bundle.session.omitted,
      bytes: byteLengthOf(JSON.stringify(bundle)),
    },
  }
}

/** 从 surface 里最后一条 assistant/message 上取 provider/model，当作中转来源元数据 */
function lastAssistantModel(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const source = event.data?.message?.source
    if (source != null && typeof source.provider === 'string' && typeof source.model === 'string') {
      return { provider: source.provider, model: source.model }
    }
  }
  return undefined
}

/* ================================================================
 * 导入
 * ================================================================ */

/**
 * 把 bundle 变成一条真实会话。
 * @param {object} ctx
 * @param {unknown} rawBundle
 * @param {{ workspaceId?: string }} [options]
 * @returns {Promise<{ sessionId: string, title: string, messages: number }>}
 */
async function importBundle(ctx, rawBundle, options = {}) {
  const checked = validateBundle(rawBundle)
  if (!checked.ok) throw new ForwardError(400, checked.error)
  const bundle = checked.bundle

  const serializedBytes = byteLengthOf(JSON.stringify(bundle))
  if (serializedBytes > MAX_BUNDLE_BYTES) {
    throw new ForwardError(413, `转发文件超过 ${Math.round(MAX_BUNDLE_BYTES / 1024 / 1024)} MiB 上限`)
  }

  // 选落点：显式 workspace > 调用方目录对应的 workspace > 第一个 workspace。
  // 必须有 workspace：cwd 落在进程目录时创建出来的会话不会出现在侧栏里（实测）。
  const target = await resolveImportTarget(ctx, options.workspaceId, options.cwd)
  const workspace = target.workspace

  const fallbackModel = defaultModelOf(ctx)
  // 事件先在内存里全部构造好：任何一条不合法都不会留下半条会话。
  const events = buildSessionEvents(bundle, {
    idFactory: () => randomUUID(),
    fallbackModel,
  })

  const createRequest = workspace !== undefined
    ? { workspaceId: workspace.id }
    : { cwd: target.cwd ?? defaultDirectoryOf(ctx) }
  let created
  try {
    created = await ctx.sessionController.create(createRequest)
  } catch (error) {
    throw new ForwardError(500, `创建会话失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const sessionId = created.sessionId

  const session = ctx.sessions.get(sessionId) ?? ctx.get('agents')?.get?.(sessionId)?.session
  if (session === undefined) {
    throw new ForwardError(500, `会话 ${sessionId} 已创建，但拿不到它的会话句柄，无法写入转发的对话`)
  }

  // 未指定 workspace 时，按目录把会话挂到已有 workspace 上，否则它会游离在侧栏之外。
  if (workspace === undefined) {
    const cwd = session.header.cwd
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const resolved = cwd === undefined ? undefined : await ctx.get('workspaceRegistry')?.resolveByPath?.(cwd)
        if (resolved !== undefined) {
          await resolved.attachSession(sessionId)
          break
        }
      } catch (error) {
        if (attempt === 1) {
          ctx.logger?.warn?.(`session-forward: session ${sessionId} was imported but not attached to a workspace: ${String(error)}`)
        }
      }
    }
  }

  let written = 0
  try {
    for (const event of events) {
      if (event.surfaceOp !== undefined) {
        session.append(event.type, event.data, { surfaceOp: event.surfaceOp })
      } else {
        session.append(event.type, event.data)
      }
      written += 1
    }
  } catch (error) {
    // create 已经成功，这里失败就会留下一条半截会话；把 id 写进错误里，至少能定位和归档。
    throw new ForwardError(
      500,
      `写入会话事件失败（会话 ${sessionId} 已创建，写入 ${written}/${events.length} 条）：${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const title = applyTitle(ctx, session, bundle.session?.title)

  try {
    await ctx.sessions.flush(session)
  } catch (error) {
    ctx.logger?.warn?.(`session-forward: flush after import failed: ${String(error)}`)
  }

  return { sessionId, title: title ?? '转发的会话', messages: bundle.messages.length }
}

/** 决定导入会话落在哪个 workspace（见 importBundle 里的注释） */
async function resolveImportTarget(ctx, workspaceId, preferredCwd) {
  const registry = ctx.get('workspaceRegistry')
  if (workspaceId !== undefined) {
    const workspace = registry?.get(workspaceId)
    if (workspace === undefined) throw new ForwardError(400, `workspace ${workspaceId} 不存在`)
    return { workspace }
  }
  const fallbackCwd = defaultDirectoryOf(ctx)
  const candidates = []
  if (typeof preferredCwd === 'string' && preferredCwd !== '') candidates.push(preferredCwd)
  if (!candidates.includes(fallbackCwd)) candidates.push(fallbackCwd)
  for (const cwd of candidates) {
    try {
      const workspace = await registry?.resolveByPath?.(cwd)
      if (workspace !== undefined) return { workspace }
    } catch {
      /* 继续试下一个候选 */
    }
  }
  let existing = []
  try {
    existing = registry?.list?.() ?? []
  } catch {
    existing = []
  }
  if (existing.length > 0) return { workspace: existing[0] }
  return { cwd: fallbackCwd }
}

function defaultModelOf(ctx) {
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (selection !== undefined && typeof selection.provider === 'string' && typeof selection.model === 'string') {
      return { provider: selection.provider, model: selection.model }
    }
  } catch {
    /* 没有默认模型时用兜底元数据 */
  }
  return { provider: 'dsh', model: 'forwarded' }
}

function defaultDirectoryOf(ctx) {
  const directory = ctx.get('workingDirectory')?.defaultDirectory
  return typeof directory === 'string' && directory !== '' ? directory : process.cwd()
}

/** 按 UTF-8 字节裁剪标题，避免撞上 session-title 的 maxTitleBytes 限制 */
function clipTitle(title, limit = TITLE_MAX_BYTES) {
  if (typeof title !== 'string') return undefined
  const trimmed = title.replace(/\s+/g, ' ').trim()
  if (trimmed === '') return undefined
  let out = ''
  let bytes = 0
  for (const char of trimmed) {
    const size = byteLengthOf(char)
    if (bytes + size > limit) break
    out += char
    bytes += size
  }
  return out === '' ? undefined : out
}

/** 设标题：先用 112 字节，被拒再退到 60 字节（profile 可能把 maxTitleBytes 调小） */
function applyTitle(ctx, session, rawTitle) {
  const titles = ctx.get('sessionTitle')
  if (titles === undefined || typeof titles.rename !== 'function') return clipTitle(rawTitle)
  for (const limit of [TITLE_MAX_BYTES, 60]) {
    const title = clipTitle(rawTitle, limit)
    if (title === undefined) return undefined
    try {
      titles.rename(session, title)
      return title
    } catch (error) {
      ctx.logger?.warn?.(`session-forward: title rename failed at ${limit} bytes: ${String(error)}`)
    }
  }
  return undefined
}

/** 转发文件里不留完整家目录路径，避免把用户名和目录结构一起发出去 */
function maskHomePath(path) {
  const home = homedir()
  if (typeof home !== 'string' || home.length < 2) return path
  if (path === home) return '~'
  if (path.startsWith(`${home}/`) || path.startsWith(`${home}\\`)) return `~${path.slice(home.length)}`
  return path
}

/** 标题会进 markdown 与文件名：压成单行，去掉首尾空白 */
function sanitizeTitle(title) {
  const line = title.replace(/\s+/g, ' ').trim()
  return line === '' ? undefined : line
}

function byteLengthOf(text) {
  return new TextEncoder().encode(text).length
}

/* ================================================================
 * Agent 工具
 * ================================================================ */

async function runTool(ctx, shares, args, exec) {
  const action = args?.action
  if (action !== 'export' && action !== 'import' && action !== 'share') {
    throw new Error('action must be "export", "import" or "share"')
  }
  const signal = exec?.signal
  if (signal?.aborted) throw new Error('cancelled')

  if (action === 'share') {
    const shared = typeof args.sessionId === 'string' && args.sessionId !== ''
      ? args.sessionId
      : exec?.agent?.id
    if (typeof shared !== 'string' || shared === '') throw new Error('cannot tell which session to share')
    if (!isPlausibleSessionId(shared)) throw new Error('sessionId looks invalid')
    const result = await createShare(ctx, shares, shared, {})
    return {
      ok: true,
      url: result.url,
      expiresAt: result.expiresAt,
      sessionId: shared,
      title: result.title,
      messages: result.messages,
    }
  }

  const fs = ctx.get('fs')
  if (fs === undefined) throw new Error('this deployment mounts no filesystem service')
  // 工具路径由模型决定，必须走带 sandbox 策略的 ctx.fs，而不是 node:fs 直写直读。
  const policy = sandboxPolicyFor(ctx, exec)
  const cwd = toolCwd(ctx, exec)

  if (action === 'export') {
    const sessionId = typeof args.sessionId === 'string' && args.sessionId !== ''
      ? args.sessionId
      : exec?.agent?.id
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('cannot tell which session to export')
    if (!isPlausibleSessionId(sessionId)) throw new Error('sessionId looks invalid')

    const result = await exportSession(ctx, sessionId)
    const requested = typeof args.path === 'string' && args.path !== '' ? args.path : undefined
    const path = await resolveExportPath(fs, cwd, result.fileName, requested)
    const target = await fs.resolve(path, { cwd, ...(signal === undefined ? {} : { signal }) })
    try {
      await fs.writeText(target, `${JSON.stringify(result.bundle, null, 2)}\n`, undefined, signal, policy)
    } catch (error) {
      throw new Error(`could not write ${target.displayPath}: ${describeFsError(error)}`)
    }
    return {
      ok: true,
      path: target.displayPath,
      sessionId,
      title: result.summary.title,
      messages: result.summary.messages,
    }
  }

  if (typeof args.path !== 'string' || !isAbsolute(args.path)) {
    throw new Error('import requires an absolute "path"')
  }
  const extension = extname(args.path).toLowerCase()
  if (extension !== '.json' && extension !== '.dshchat') {
    throw new Error('import path must be a .json or .dshchat file')
  }
  const target = await fs.resolve(args.path, { cwd, ...(signal === undefined ? {} : { signal }) })
  const info = await fs.stat(target, signal)
  if (info === undefined) throw new Error(`file not found: ${target.displayPath}`)
  if (info.type !== 'file') throw new Error(`not a regular file: ${target.displayPath}`)
  if (typeof info.size === 'number' && info.size > MAX_BUNDLE_BYTES) {
    throw new Error('forwarding file exceeds the size limit')
  }
  let text
  try {
    text = await fs.readText(target, signal)
  } catch (error) {
    throw new Error(`could not read ${target.displayPath}: ${describeFsError(error)}`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('file is not valid JSON')
  }
  const result = await importBundle(ctx, parsed, {
    workspaceId: typeof args.workspaceId === 'string' && args.workspaceId !== '' ? args.workspaceId : undefined,
    cwd: toolCwd(ctx, exec),
  })
  return { ok: true, ...result }
}

/** 工具调用所在的会话目录，用作相对路径基准与导出默认目录 */
function toolCwd(ctx, exec) {
  const sessionCwd = exec?.agent?.session?.header?.cwd
  return typeof sessionCwd === 'string' && sessionCwd !== '' ? sessionCwd : defaultDirectoryOf(ctx)
}

/** 本次工具调用应使用的 sandbox 策略（与 dsh-tool-fs 的取值方式一致） */
function sandboxPolicyFor(ctx, exec) {
  const policy = ctx.get('sandboxPolicy')
  if (policy === undefined) return undefined
  try {
    const session = exec?.agent?.session
    return session === undefined ? policy.resolve() : policy.resolve({ session })
  } catch (error) {
    ctx.logger?.warn?.(`session-forward: sandbox policy resolution failed: ${String(error)}`)
    return undefined
  }
}

function describeFsError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 300 ? `${message.slice(0, 300)}…` : message
}

async function resolveExportPath(fs, cwd, fileName, requested) {
  if (requested === undefined) return join(cwd, fileName)
  if (!isAbsolute(requested)) throw new Error('export path must be absolute')
  // 以分隔符结尾或已存在同名目录时视为目录，其余情况按文件路径处理。
  if (requested.endsWith('/') || requested.endsWith('\\')) return join(requested, fileName)
  try {
    const info = await fs.stat(await fs.resolve(requested, { cwd }))
    if (info?.type === 'directory') return join(requested, fileName)
  } catch {
    /* 目标不存在：按文件处理 */
  }
  return requested
}

function isPlausibleSessionId(value) {
  return value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value)
}

function describeToolValue(value) {
  if (value?.ok !== true) return 'session_forward failed'
  if (typeof value.url === 'string') {
    const until = Number.isFinite(value.expiresAt) ? new Date(value.expiresAt).toISOString().slice(0, 16).replace('T', ' ') : 'unknown'
    return `Share link (valid until ${until}): ${value.url}`
  }
  if (typeof value.path === 'string') {
    return `Exported session ${value.sessionId ?? ''} to ${value.path} (${value.messages ?? 0} messages).`
  }
  return `Imported ${value.messages ?? 0} messages into session ${value.sessionId ?? ''}${value.title ? ` "` + value.title + `"` : ''}.`
}

