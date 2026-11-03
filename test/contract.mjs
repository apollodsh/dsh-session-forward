/**
 * 可选：把合成出来的事件真正塞进宿主的 @deepseek-ai/dsh-session 里跑一遍。
 *
 * 这是本测试套件里唯一「依赖宿主」的部分：它从已安装的 DeepSeek Harness
 * 的 app.asar 里直接 import 真实的 session 实现，用它的 seed 校验
 * （adoptSessionEvent / Session.create）来证明 buildSessionEvents() 造出来的
 * 事件不是「看起来像」，而是真的能进会话日志、能 deriveMessages() 出来。
 *
 * 拿不到宿主（换机器 / 换路径 / asar 读不了）时返回 undefined，调用方按
 * skipped 处理，整体结果仍然可判定。
 */
import fs from 'node:fs'

const APP = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
const SESSION_ENTRY = `${APP}/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js`

export function contractEntryPath() {
  return SESSION_ENTRY
}

export function contractAvailable() {
  try {
    return fs.existsSync(SESSION_ENTRY)
  } catch {
    return false
  }
}

/**
 * @returns {Promise<null | { Session: any, adoptSessionEvent: any, snapshotSessionEvent: any,
 *   foldSurface: any, deriveEventMessage: any, SESSION_FORMAT_VERSION: number,
 *   KNOWN_SESSION_EVENT_TYPES: Set<string> }>}
 */
export async function loadSessionContract() {
  if (!contractAvailable()) return null
  try {
    const mod = await import(SESSION_ENTRY)
    if (typeof mod.Session?.create !== 'function') return null
    return mod
  } catch {
    return null
  }
}

/**
 * 把 buildSessionEvents() 的输出包成宿主认可的事件信封（补 seq / time）。
 * append 路径会自己生成 seq/time；这里模拟「落盘读回」的形态。
 */
export function toEnvelope(events, { startTime = 1_760_000_000_000 } = {}) {
  return events.map((event, index) => ({
    type: event.type,
    seq: index,
    time: startTime + index,
    data: event.data,
    ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }),
  }))
}

/** 造一个合法的 SessionHeader（宿主 store 平时填 version/id/createdAt）。 */
export function makeHeader(SESSION_FORMAT_VERSION, id = 'session-forwarded-test') {
  return { version: SESSION_FORMAT_VERSION, id, createdAt: 1_760_000_000_000, isSeeded: false }
}
