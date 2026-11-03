/**
 * dsh-session-forward · 纯逻辑层（零依赖，可在 node 里直接单测）
 *
 * 这里只做三件事，全部是纯函数，不接触 ctx / fs / 网络：
 *   1. 从一份会话事件流里抽出「人看得见的对话」（user/assistant 文本）
 *   2. 把它打包成可转发的 JSON bundle（.dshchat）
 *   3. 把 bundle 反解成 recipient 会话日志里的标准事件序列（turn/step/message）
 *
 * 为什么不是原样搬事件日志：日志里有工具调用、推理流、附件 id、请求头等
 * 只属于导出方进程/工作目录的东西。转发出去的是「对话本身」，落到对方 DSH 里
 * 必须是一条结构合法、能继续聊下去的普通会话。
 */

export const BUNDLE_FORMAT = 'dsh-session-forward'
export const BUNDLE_VERSION = 1

/** 单条消息文本上限（字符）；超长时截断并标记，避免一个 bundle 撑爆请求体 */
export const MAX_MESSAGE_CHARS = 200_000
/** bundle 里的消息条数上限 */
export const MAX_MESSAGES = 5_000
/** 允许导入的 bundle 最大序列化字节数（约 24 MiB） */
export const MAX_BUNDLE_BYTES = 24 * 1024 * 1024

const ROLE_USER = 'user'
const ROLE_ASSISTANT = 'assistant'

/** 只接受人类真正发出的 user 消息：注入的运行时上下文 / 技能目录 / 压缩检查点都排除 */
function isHumanUserMessage(data) {
  const source = data && data.source
  return source != null && source.kind === 'user'
}

/** 拼接 content 里所有 text block；非文本块返回空串并计入统计 */
function textOfContent(content, stats) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block == null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (block.type === 'reasoning') {
      if (stats) stats.reasoning += 1
    } else if (block.type === 'tool-call') {
      if (stats) stats.toolCalls += 1
    } else if (block.type === 'image') {
      if (stats) stats.images += 1
    } else if (block.type === 'file') {
      if (stats) stats.files += 1
    }
  }
  return parts.join('\n').trim()
}

function clipText(text) {
  if (text.length <= MAX_MESSAGE_CHARS) return { text, truncated: false }
  return { text: text.slice(0, MAX_MESSAGE_CHARS), truncated: true }
}

/** buildBundle 的防御性入口：只保留形状正确的消息，外部直接传脏数组也不会炸 */
function normalizeMessages(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const item of list) {
    if (item == null || typeof item !== 'object') continue
    if (item.role !== ROLE_USER && item.role !== ROLE_ASSISTANT) continue
    if (typeof item.text !== 'string' || item.text.trim() === '') continue
    const { text, truncated } = clipText(item.text)
    out.push({
      role: item.role,
      text,
      time: Number.isFinite(item.time) ? item.time : 0,
      ...(truncated ? { truncated: true } : {}),
    })
    if (out.length >= MAX_MESSAGES) break
  }
  return out
}

/**
 * 从「当前 surface」的事件列表里抽出对话。
 * 调用方应传入 `sessionQuery.readSurface()` 的 events（已展开 replace，只剩当前可见节点）；
 * 传原始日志也能跑，但压缩过的旧消息会漏进结果。
 *
 * @param {readonly object[]} events
 * @returns {{ messages: Array<{role:'user'|'assistant', text: string, time: number}>,
 *             stats: { userMessages: number, assistantMessages: number, toolCalls: number,
 *                      toolResults: number, reasoning: number, images: number, files: number,
 *                      truncated: number }, skipped: number }}
 */
export function extractTranscript(events) {
  const messages = []
  const stats = {
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    reasoning: 0,
    images: 0,
    files: 0,
    truncated: 0,
  }
  let skipped = 0
  const list = Array.isArray(events) ? events : []

  for (const event of list) {
    if (event == null || typeof event !== 'object') continue
    const type = event.type
    const data = event.data
    if (type === 'tool/result') {
      stats.toolResults += 1
      continue
    }
    if (type !== 'user/message' && type !== 'assistant/message') continue
    if (type === 'user/message' && !isHumanUserMessage(data)) {
      skipped += 1
      continue
    }
    const message = type === 'user/message' ? data : data && data.message
    if (message == null || typeof message !== 'object') continue
    const raw = textOfContent(message.content, type === 'assistant/message' ? stats : null)
    if (raw === '') continue
    const { text, truncated } = clipText(raw)
    if (truncated) stats.truncated += 1
    messages.push({
      role: type === 'user/message' ? ROLE_USER : ROLE_ASSISTANT,
      text,
      time: Number.isFinite(event.time) ? event.time : 0,
    })
    if (type === 'user/message') stats.userMessages += 1
    else stats.assistantMessages += 1
    if (messages.length >= MAX_MESSAGES) break
  }

  return { messages, stats, skipped }
}

/**
 * 打包 bundle。
 * @param {object} input
 * @param {Array<{role:string,text:string,time:number}>} input.messages
 * @param {ReturnType<typeof extractTranscript>['stats']} [input.stats]
 * @param {{ id?: string, title?: string, cwd?: string, createdAt?: number,
 *           provider?: string, model?: string }} [input.session]
 * @param {{ version?: string }} [input.app]
 * @param {number} [input.now]
 * @returns {object} bundle
 */
export function buildBundle(input) {
  const messages = normalizeMessages(input.messages)
  const stats = input.stats ?? {}
  const session = input.session ?? {}
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const title = typeof session.title === 'string' && session.title.trim() !== ''
    ? session.title.trim()
    : defaultTitle(messages)
  const provider = typeof session.provider === 'string' && session.provider !== '' ? session.provider : undefined
  const model = typeof session.model === 'string' && session.model !== '' ? session.model : undefined

  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: now,
    exportedAtIso: new Date(now).toISOString(),
    app: { name: 'DeepSeek Harness', version: typeof input.app?.version === 'string' ? input.app.version : undefined },
    session: {
      id: typeof session.id === 'string' ? session.id : undefined,
      title,
      cwd: typeof session.cwd === 'string' ? session.cwd : undefined,
      createdAt: Number.isFinite(session.createdAt) ? session.createdAt : undefined,
      provider,
      model,
      messageCount: messages.length,
      userMessages: messages.filter((m) => m.role === ROLE_USER).length,
      assistantMessages: messages.filter((m) => m.role === ROLE_ASSISTANT).length,
      omitted: {
        toolCalls: stats.toolCalls ?? 0,
        toolResults: stats.toolResults ?? 0,
        reasoning: stats.reasoning ?? 0,
        images: stats.images ?? 0,
        files: stats.files ?? 0,
        truncated: stats.truncated ?? 0,
      },
    },
    messages,
  }
}

function defaultTitle(messages) {
  const first = messages.find((m) => m.role === ROLE_USER && typeof m.text === 'string' && m.text.trim() !== '')
  if (first === undefined) return '转发的会话'
  const line = first.text.replace(/\s+/g, ' ').trim()
  return line.length > 40 ? `${line.slice(0, 40)}…` : line
}

/**
 * 生成可读的 Markdown 记录，用于「复制」到聊天软件里。
 * @param {object} bundle
 * @returns {string}
 */
export function bundleToMarkdown(bundle) {
  const session = bundle.session ?? {}
  const messages = Array.isArray(bundle.messages) ? bundle.messages : []
  const when = typeof bundle.exportedAtIso === 'string'
    ? bundle.exportedAtIso
    : new Date(Number(bundle.exportedAt) || Date.now()).toISOString()
  const lines = []
  lines.push(`# ${session.title ?? '转发的会话'}`)
  lines.push('')
  const meta = [`转发自 DSH`, when.slice(0, 16).replace('T', ' ')]
  if (typeof session.cwd === 'string' && session.cwd !== '') meta.push(session.cwd)
  lines.push(`> ${meta.join(' · ')}`)
  lines.push('')
  for (const message of messages) {
    const label = message.role === ROLE_USER ? '我' : '助手'
    lines.push(`**${label}**`)
    lines.push('')
    lines.push(String(message.text ?? ''))
    lines.push('')
  }
  return lines.join('\n')
}

/** 安全文件名：把标题压成一个可下载的文件名 */
export function suggestFileName(title) {
  const base = (typeof title === 'string' ? title : '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/[. ]+$/, '')
    .trim()
  return `${base === '' ? 'dsh-session' : base}.dshchat.json`
}

/**
 * 校验并规范化外部传入的 bundle。宁可拒绝，也不把脏数据写进会话日志。
 * @param {unknown} value
 * @returns {{ ok: true, bundle: object } | { ok: false, error: string }}
 */
export function validateBundle(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('文件内容不是一个转发对象')
  }
  const bundle = value
  if (bundle.format !== BUNDLE_FORMAT) {
    return fail(`不是 DSH 会话转发文件（format=${JSON.stringify(bundle.format)}）`)
  }
  const version = bundle.version
  if (!Number.isInteger(version) || version < 1) return fail(`文件版本号非法（version=${JSON.stringify(version)}）`)
  if (version > BUNDLE_VERSION) {
    return fail(`文件版本 ${version} 比当前插件支持的 ${BUNDLE_VERSION} 更新，请升级插件`)
  }
  const rawMessages = bundle.messages
  if (!Array.isArray(rawMessages)) return fail('缺少 messages 数组')
  if (rawMessages.length === 0) return fail('这个转发里没有任何消息')
  if (rawMessages.length > MAX_MESSAGES) return fail(`消息条数 ${rawMessages.length} 超过上限 ${MAX_MESSAGES}`)
  const messages = []
  for (let index = 0; index < rawMessages.length; index += 1) {
    const item = rawMessages[index]
    if (item == null || typeof item !== 'object') return fail(`第 ${index + 1} 条消息格式非法`)
    if (item.role !== ROLE_USER && item.role !== ROLE_ASSISTANT) {
      return fail(`第 ${index + 1} 条消息角色非法（${JSON.stringify(item.role)}）`)
    }
    if (typeof item.text !== 'string') return fail(`第 ${index + 1} 条消息缺少文本`)
    const { text, truncated } = clipText(item.text)
    if (text.trim() === '') continue
    messages.push({
      role: item.role,
      text,
      time: Number.isFinite(item.time) ? item.time : 0,
      ...(truncated ? { truncated: true } : {}),
    })
  }
  if (messages.length === 0) return fail('所有消息都是空的')

  const session = bundle.session ?? {}
  const normalized = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: Number.isFinite(bundle.exportedAt) ? bundle.exportedAt : Date.now(),
    exportedAtIso: typeof bundle.exportedAtIso === 'string'
      ? bundle.exportedAtIso
      : new Date(Number.isFinite(bundle.exportedAt) ? bundle.exportedAt : Date.now()).toISOString(),
    app: bundle.app ?? { name: 'DeepSeek Harness' },
    session: {
      id: typeof session.id === 'string' ? session.id : undefined,
      title: typeof session.title === 'string' ? session.title : undefined,
      cwd: typeof session.cwd === 'string' ? session.cwd : undefined,
      createdAt: Number.isFinite(session.createdAt) ? session.createdAt : undefined,
      provider: typeof session.provider === 'string' && session.provider !== '' ? session.provider : undefined,
      model: typeof session.model === 'string' && session.model !== '' ? session.model : undefined,
      messageCount: messages.length,
    },
    messages,
  }
  return { ok: true, bundle: normalized }
}

function fail(error) {
  return { ok: false, error }
}

/**
 * 把 bundle 变成 recipient 会话日志里的事件序列。
 *
 * 结构（每个 turn 一次问答）：
 *   turn/start → [step/start user/message step/end] → [step/start assistant/message step/end] → turn/end
 * 表层事件必须带 surfaceOp:'append'，assistant/message 需要 provider/model 元数据。
 *
 * @param {object} bundle 已通过 validateBundle 的 bundle
 * @param {object} [options]
 * @param {(prefix: string) => string} [options.idFactory] 生成 MessageId，默认随机 uuid
 * @param {{ provider: string, model: string }} [options.fallbackModel] bundle 没带模型时使用的来源元数据
 * @returns {Array<{ type: string, data: object, surfaceOp?: 'append' }>}
 */
export function buildSessionEvents(bundle, options = {}) {
  const idFactory = typeof options.idFactory === 'function' ? options.idFactory : randomId
  const fallback = options.fallbackModel ?? { provider: 'dsh', model: 'forwarded' }
  const source = {
    kind: 'model',
    provider: typeof bundle.session?.provider === 'string' && bundle.session.provider !== ''
      ? bundle.session.provider
      : fallback.provider,
    model: typeof bundle.session?.model === 'string' && bundle.session.model !== ''
      ? bundle.session.model
      : fallback.model,
  }
  // provider/model 必须是字符串，否则会话反序列化会在客户端校验处失败
  if (typeof source.provider !== 'string' || source.provider === '') source.provider = 'dsh'
  if (typeof source.model !== 'string' || source.model === '') source.model = 'forwarded'

  const turns = groupTurns(bundle.messages ?? [])
  const events = []
  let turn = 0
  for (const item of turns) {
    turn += 1
    events.push({ type: 'turn/start', data: { turn } })
    let step = 0
    if (item.user !== undefined) {
      step += 1
      events.push({ type: 'step/start', data: { turn, step } })
      events.push({
        type: 'user/message',
        data: {
          role: 'user',
          content: [{ type: 'text', text: item.user }],
          source: { kind: 'user' },
          id: idFactory('message'),
        },
        surfaceOp: 'append',
      })
      events.push({ type: 'step/end', data: { turn, step } })
    }
    for (const text of item.assistant) {
      step += 1
      events.push({ type: 'step/start', data: { turn, step } })
      events.push({
        type: 'assistant/message',
        data: {
          turn,
          step,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text }],
            source: { ...source },
            id: idFactory('message'),
          },
          stream: [],
        },
        surfaceOp: 'append',
      })
      events.push({ type: 'step/end', data: { turn, step } })
    }
    events.push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  return events
}

/** 把线性消息序列折成 turn：一条 user 开启一个新 turn，其后的 assistant 依次落在这个 turn 里 */
function groupTurns(messages) {
  const turns = []
  let current
  for (const message of messages) {
    if (message.role === ROLE_USER) {
      current = { user: message.text, assistant: [] }
      turns.push(current)
      continue
    }
    if (current === undefined) {
      current = { user: undefined, assistant: [] }
      turns.push(current)
    }
    current.assistant.push(message.text)
  }
  return turns
}

function randomId(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid === undefined ? `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}` : uuid
}
