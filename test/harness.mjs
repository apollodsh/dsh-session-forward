/**
 * 极简测试脚手架：按组计数，失败/警告都记下细节，最后统一汇报并决定退出码。
 *
 * 为什么不用 node:test / vitest：插件本身零依赖，测试也要能在「没装 node 的机器」
 * 上用 Electron 内置的 node 直接跑；自带 60 行脚手架比引依赖更省事，也不会和
 * 宿主的 node_modules 解析规则打架。
 */

export function createHarness() {
  const groups = []
  const failures = []
  const warnings = []
  let current = { name: '(未分组)', pass: 0, fail: 0, warn: 0 }
  groups.push(current)

  function group(name) {
    current = { name, pass: 0, fail: 0, warn: 0 }
    groups.push(current)
  }

  function short(value, limit = 160) {
    if (typeof value === 'string') return value.length > limit ? `${value.slice(0, limit)}…(${value.length} chars)` : JSON.stringify(value)
    if (value === undefined) return 'undefined'
    let text
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
    if (text === undefined) return String(value)
    return text.length > limit ? `${text.slice(0, limit)}…(${text.length} chars)` : text
  }

  function pass() {
    current.pass += 1
  }

  function fail(message, detail) {
    current.fail += 1
    failures.push({ group: current.name, message, detail })
  }

  function warn(message) {
    current.warn += 1
    warnings.push({ group: current.name, message })
  }

  /** 断言一个条件为真。 */
  function ok(value, message, detail) {
    if (value) pass()
    else fail(message, detail)
    return Boolean(value)
  }

  /** 断言严格相等（NaN 视为相等，便于数字断言）。 */
  function eq(actual, expected, message) {
    const same = actual === expected || (Number.isNaN(actual) && Number.isNaN(expected))
    if (same) pass()
    else fail(message, `期望 ${short(expected)}，实际 ${short(actual)}`)
    return same
  }

  /** 断言 JSON 结构相等（键顺序无关）。 */
  function deepEq(actual, expected, message) {
    const a = stable(actual)
    const b = stable(expected)
    if (a === b) pass()
    else fail(message, `期望 ${short(b)}，实际 ${short(a)}`)
    return a === b
  }

  /** 断言字符串匹配。 */
  function match(actual, pattern, message) {
    if (typeof actual === 'string' && pattern.test(actual)) pass()
    else fail(message, `期望匹配 ${pattern}，实际 ${short(actual)}`)
  }

  /** 断言函数抛错，且（可选）错误信息匹配。 */
  function throws(fn, message, pattern) {
    try {
      const value = fn()
      fail(message, `期望抛错，实际返回 ${short(value)}`)
      return false
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      if (pattern !== undefined && !pattern.test(text)) {
        fail(message, `错误信息不匹配 ${pattern}：${short(text)}`)
        return false
      }
      pass()
      return true
    }
  }

  /** 断言函数不抛错，返回它的返回值。 */
  function noThrow(fn, message) {
    try {
      const value = fn()
      pass()
      return value
    } catch (error) {
      fail(message, `意外抛错：${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /** 记录一条「已知偏差」：不算失败，但汇总里单独列出，Review 会跟踪。 */
  function warnIf(condition, message) {
    if (condition) warn(message)
    else pass()
    return Boolean(condition)
  }

  function report({ title, verbose = false } = {}) {
    const flat = groups.filter((entry) => entry.pass + entry.fail + entry.warn > 0 || entry === groups[0])
    let pass = 0
    let fail = 0
    let warn = 0
    for (const entry of flat) {
      pass += entry.pass
      fail += entry.fail
      warn += entry.warn
    }
    if (verbose) {
      for (const entry of flat) {
        console.log(`- ${entry.name}: ${entry.pass} passed, ${entry.fail} failed, ${entry.warn} warned`)
      }
      console.log('')
    }
    if (failures.length > 0) {
      console.log('\n失败明细:')
      for (const failure of failures) {
        console.log(`  ✗ [${failure.group}] ${failure.message}`)
        if (failure.detail !== undefined) console.log(`      ${failure.detail}`)
      }
    }
    if (warnings.length > 0) {
      console.log('\n已知偏差 / 观察（不影响退出码，见 test/REVIEW.md）:')
      for (const warning of warnings) console.log(`  ~ [${warning.group}] ${warning.message}`)
    }
    console.log('')
    if (title !== undefined) console.log(title)
    console.log(`PASS ${pass}  FAIL ${fail}  WARN ${warn}`)
    if (fail === 0) console.log('结果: PASS')
    else console.log('结果: FAIL')
    return { pass, fail, warn }
  }

  return { group, ok, eq, deepEq, match, throws, noThrow, warn, warnIf, report, state: () => ({ groups, failures, warnings }) }
}

/** 键排序后的 JSON 串，用于结构比较。 */
function stable(value) {
  if (value === undefined) return '"<undefined>"'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
}
