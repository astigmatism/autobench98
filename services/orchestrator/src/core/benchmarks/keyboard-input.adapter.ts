// services/orchestrator/src/core/benchmarks/keyboard-input.adapter.ts

import type { PS2KeyboardService } from '../../devices/ps2-keyboard/PS2KeyboardService.js'
import type {
  ClientKeyboardEvent,
  KeyboardAction,
  KeyboardOperationResult,
} from '../../devices/ps2-keyboard/types.js'
import type { BenchmarkKeyboardInputAdapter } from './types.js'

type KeyboardProvider = () => Pick<PS2KeyboardService, 'enqueueKeyEvent' | 'cancelAll'> | undefined

type LoggerLike = {
  warn(msg: string, extra?: Record<string, unknown>): void
  debug(msg: string, extra?: Record<string, unknown>): void
}

const noopLogger: LoggerLike = {
  warn: () => undefined,
  debug: () => undefined,
}

const MODIFIER_CODES = new Set([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
])

const NAMED_KEYS: Record<string, string> = {
  ENTER: 'Enter',
  RETURN: 'Enter',
  ESC: 'Escape',
  ESCAPE: 'Escape',
  SPACE: 'Space',
  TAB: 'Tab',
  BACKSPACE: 'Backspace',
  DELETE: 'Delete',
  DEL: 'Delete',
  INSERT: 'Insert',
  INS: 'Insert',
  HOME: 'Home',
  END: 'End',
  PAGEUP: 'PageUp',
  PAGEDOWN: 'PageDown',
  PGUP: 'PageUp',
  PGDN: 'PageDown',
  ARROWUP: 'ArrowUp',
  UP: 'ArrowUp',
  ARROWDOWN: 'ArrowDown',
  DOWN: 'ArrowDown',
  ARROWLEFT: 'ArrowLeft',
  LEFT: 'ArrowLeft',
  ARROWRIGHT: 'ArrowRight',
  RIGHT: 'ArrowRight',
  SHIFT: 'ShiftLeft',
  SHIFTLEFT: 'ShiftLeft',
  SHIFTRIGHT: 'ShiftRight',
  CTRL: 'ControlLeft',
  CONTROL: 'ControlLeft',
  CONTROLLEFT: 'ControlLeft',
  CONTROLRIGHT: 'ControlRight',
  ALT: 'AltLeft',
  ALTLEFT: 'AltLeft',
  ALTRIGHT: 'AltRight',
  META: 'MetaLeft',
  WIN: 'MetaLeft',
  WINDOWS: 'MetaLeft',
  COMMAND: 'MetaLeft',
  METALEFT: 'MetaLeft',
  METARIGHT: 'MetaRight',
}

const CHAR_TO_KEY: Record<string, { code: string; shift?: boolean }> = {
  ' ': { code: 'Space' },
  '\n': { code: 'Enter' },
  '\r': { code: 'Enter' },
  '\t': { code: 'Tab' },

  '0': { code: 'Digit0' },
  '1': { code: 'Digit1' },
  '2': { code: 'Digit2' },
  '3': { code: 'Digit3' },
  '4': { code: 'Digit4' },
  '5': { code: 'Digit5' },
  '6': { code: 'Digit6' },
  '7': { code: 'Digit7' },
  '8': { code: 'Digit8' },
  '9': { code: 'Digit9' },

  '!': { code: 'Digit1', shift: true },
  '@': { code: 'Digit2', shift: true },
  '#': { code: 'Digit3', shift: true },
  '$': { code: 'Digit4', shift: true },
  '%': { code: 'Digit5', shift: true },
  '^': { code: 'Digit6', shift: true },
  '&': { code: 'Digit7', shift: true },
  '*': { code: 'Digit8', shift: true },
  '(': { code: 'Digit9', shift: true },
  ')': { code: 'Digit0', shift: true },

  '-': { code: 'Minus' },
  '_': { code: 'Minus', shift: true },
  '=': { code: 'Equal' },
  '+': { code: 'Equal', shift: true },
  '[': { code: 'BracketLeft' },
  '{': { code: 'BracketLeft', shift: true },
  ']': { code: 'BracketRight' },
  '}': { code: 'BracketRight', shift: true },
  '\\': { code: 'Backslash' },
  '|': { code: 'Backslash', shift: true },
  ';': { code: 'Semicolon' },
  ':': { code: 'Semicolon', shift: true },
  "'": { code: 'Quote' },
  '"': { code: 'Quote', shift: true },
  ',': { code: 'Comma' },
  '<': { code: 'Comma', shift: true },
  '.': { code: 'Period' },
  '>': { code: 'Period', shift: true },
  '/': { code: 'Slash' },
  '?': { code: 'Slash', shift: true },
  '`': { code: 'Backquote' },
  '~': { code: 'Backquote', shift: true },
}

for (let i = 0; i < 26; i++) {
  const lower = String.fromCharCode('a'.charCodeAt(0) + i)
  const upper = lower.toUpperCase()
  const code = `Key${upper}`
  CHAR_TO_KEY[lower] = { code }
  CHAR_TO_KEY[upper] = { code, shift: true }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const delay = Math.max(0, Math.trunc(ms))
  if (delay <= 0) return Promise.resolve()
  if (signal?.aborted) return Promise.reject(new Error('operation cancelled'))

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, delay)

    const onAbort = () => {
      cleanup()
      reject(new Error('operation cancelled'))
    }

    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('operation cancelled')
}

function normalizeKeyToken(token: string): string {
  const raw = token.trim()
  if (!raw) throw new Error('empty key token')

  const upper = raw.toUpperCase().replace(/[\s_+-]/g, '')
  const named = NAMED_KEYS[upper]
  if (named) return named

  if (/^F([1-9]|1[0-2])$/.test(upper)) return upper

  if (/^[A-Z]$/.test(raw)) return `Key${raw.toUpperCase()}`
  if (/^[0-9]$/.test(raw)) return `Digit${raw}`

  if (/^KEY[A-Z]$/.test(upper)) return `Key${upper.slice(3)}`
  if (/^DIGIT[0-9]$/.test(upper)) return `Digit${upper.slice(5)}`

  // Already looks like a KeyboardEvent.code value.
  if (/^(Key[A-Z]|Digit[0-9]|Arrow(Up|Down|Left|Right)|F([1-9]|1[0-2]))$/.test(raw)) {
    return raw
  }

  // Preserve known camel-case names if caller already supplied them.
  if (
    raw === 'Enter' ||
    raw === 'Escape' ||
    raw === 'Space' ||
    raw === 'Tab' ||
    raw === 'Backspace' ||
    raw === 'Insert' ||
    raw === 'Delete' ||
    raw === 'Home' ||
    raw === 'End' ||
    raw === 'PageUp' ||
    raw === 'PageDown' ||
    raw === 'Minus' ||
    raw === 'Equal' ||
    raw === 'BracketLeft' ||
    raw === 'BracketRight' ||
    raw === 'Backslash' ||
    raw === 'Semicolon' ||
    raw === 'Quote' ||
    raw === 'Comma' ||
    raw === 'Period' ||
    raw === 'Slash' ||
    raw === 'Backquote' ||
    MODIFIER_CODES.has(raw)
  ) {
    return raw
  }

  const mappedChar = CHAR_TO_KEY[raw]
  if (mappedChar && raw.length === 1) return mappedChar.code

  throw new Error(`Unsupported key token: ${token}`)
}

function isModifierCode(code: string): boolean {
  return MODIFIER_CODES.has(code)
}

function describeResult(result: KeyboardOperationResult): string {
  if (result.status === 'completed') return 'completed'
  if (result.status === 'cancelled') return `cancelled: ${result.reason ?? 'cancelled'}`
  if (result.error?.message) return `${result.status}: ${result.error.message}`
  return result.status
}

export class PS2KeyboardBenchmarkInputAdapter implements BenchmarkKeyboardInputAdapter {
  private readonly getKeyboard: KeyboardProvider
  private readonly log: LoggerLike

  constructor(opts: { getKeyboard: KeyboardProvider; logger?: LoggerLike }) {
    this.getKeyboard = opts.getKeyboard
    this.log = opts.logger ?? noopLogger
  }

  async typeText(
    text: string,
    opts?: { interKeyDelayMs?: number; requestedBy?: string; signal?: AbortSignal }
  ): Promise<Record<string, unknown>> {
    const requestedBy = opts?.requestedBy ?? 'benchmark-runner'
    const interKeyDelayMs = Math.max(0, Math.trunc(opts?.interKeyDelayMs ?? 0))
    let charsTyped = 0

    for (const ch of text) {
      assertNotAborted(opts?.signal)
      const mapped = CHAR_TO_KEY[ch]
      if (!mapped) throw new Error(`Unsupported character for keyboard.typeText: ${JSON.stringify(ch)}`)

      if (mapped.shift) {
        await this.enqueue('hold', 'ShiftLeft', requestedBy, opts?.signal)
      }

      try {
        await this.enqueue('press', mapped.code, requestedBy, opts?.signal)
        charsTyped++
      } finally {
        if (mapped.shift) {
          await this.enqueue('release', 'ShiftLeft', requestedBy).catch((err) => {
            this.log.warn('failed to release ShiftLeft after shifted character', {
              err: err instanceof Error ? err.message : String(err),
            })
          })
        }
      }

      if (interKeyDelayMs > 0) await sleep(interKeyDelayMs, opts?.signal)
    }

    return { charsTyped, interKeyDelayMs }
  }

  async pressKey(
    key: string,
    opts?: { action?: 'press' | 'hold' | 'release'; requestedBy?: string; signal?: AbortSignal }
  ): Promise<Record<string, unknown>> {
    const requestedBy = opts?.requestedBy ?? 'benchmark-runner'
    const action = opts?.action ?? 'press'
    const code = normalizeKeyToken(key)
    await this.enqueue(action, code, requestedBy, opts?.signal)
    return { key, code, action }
  }

  async hotkey(
    keys: string[],
    opts?: { interKeyDelayMs?: number; requestedBy?: string; signal?: AbortSignal }
  ): Promise<Record<string, unknown>> {
    const requestedBy = opts?.requestedBy ?? 'benchmark-runner'
    const interKeyDelayMs = Math.max(0, Math.trunc(opts?.interKeyDelayMs ?? 20))
    const codes = keys.map(normalizeKeyToken)

    if (codes.length === 0) throw new Error('keyboard.hotkey requires at least one key')
    if (codes.length === 1) {
      await this.enqueue('press', codes[0], requestedBy, opts?.signal)
      return { keys, codes, interKeyDelayMs }
    }

    const modifiers = codes.slice(0, -1)
    const finalKey = codes[codes.length - 1]

    for (const code of modifiers) {
      if (!isModifierCode(code)) {
        throw new Error(`keyboard.hotkey modifiers must precede the final key; ${code} is not a modifier`)
      }
    }

    const held: string[] = []
    try {
      for (const code of modifiers) {
        assertNotAborted(opts?.signal)
        await this.enqueue('hold', code, requestedBy, opts?.signal)
        held.push(code)
        if (interKeyDelayMs > 0) await sleep(interKeyDelayMs, opts?.signal)
      }

      await this.enqueue('press', finalKey, requestedBy, opts?.signal)
      return { keys, codes, interKeyDelayMs }
    } finally {
      for (const code of held.reverse()) {
        await this.enqueue('release', code, requestedBy).catch((err) => {
          this.log.warn('failed to release hotkey modifier', {
            code,
            err: err instanceof Error ? err.message : String(err),
          })
        })
      }
    }
  }

  cancelAll(reason = 'benchmark-runner-cancelled'): void {
    try {
      this.getKeyboard()?.cancelAll(reason)
    } catch (err) {
      this.log.debug('keyboard cancelAll failed', {
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private async enqueue(
    action: KeyboardAction,
    code: string,
    requestedBy: string,
    signal?: AbortSignal
  ): Promise<void> {
    assertNotAborted(signal)
    const kb = this.getKeyboard()
    if (!kb) throw new Error('PS/2 keyboard service is not available')

    const evt: ClientKeyboardEvent = {
      action,
      code,
      requestedBy,
    }

    const handle = kb.enqueueKeyEvent(evt)
    const result = await handle.done.catch((err: unknown) => err as KeyboardOperationResult)

    assertNotAborted(signal)

    if (!result || result.status !== 'completed') {
      throw new Error(`Keyboard operation failed for ${action} ${code}: ${describeResult(result)}`)
    }
  }
}
