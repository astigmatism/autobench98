// services/orchestrator/src/devices/ps2-keyboard/scancodes.ts

/* -------------------------------------------------------------------------- */
/*  PS/2 Set 2 scan code definitions                                          */
/*                                                                            */
/*  - Authoritative mapping for the keyboard service                           */
/*  - Used by press/hold/release/type/combo operations                         */
/*  - Mirrors the expectations of the Arduino sketch                           */
/*                                                                            */
/*  Notes:                                                                    */
/*  - prefix 0x00 means "no prefix"                                            */
/*  - extended keys use prefix 0xE0                                           */
/*  - values are expressed as hex bytes                                       */
/* -------------------------------------------------------------------------- */

export interface ScanCode {
  prefix?: number
  code: number
}

/* -------------------------------------------------------------------------- */
/*  Alphanumeric keys                                                         */
/* -------------------------------------------------------------------------- */

export const ScanCodes: Record<string, ScanCode> = {
  // Letters
  KeyA: { code: 0x1c },
  KeyB: { code: 0x32 },
  KeyC: { code: 0x21 },
  KeyD: { code: 0x23 },
  KeyE: { code: 0x24 },
  KeyF: { code: 0x2b },
  KeyG: { code: 0x34 },
  KeyH: { code: 0x33 },
  KeyI: { code: 0x43 },
  KeyJ: { code: 0x3b },
  KeyK: { code: 0x42 },
  KeyL: { code: 0x4b },
  KeyM: { code: 0x3a },
  KeyN: { code: 0x31 },
  KeyO: { code: 0x44 },
  KeyP: { code: 0x4d },
  KeyQ: { code: 0x15 },
  KeyR: { code: 0x2d },
  KeyS: { code: 0x1b },
  KeyT: { code: 0x2c },
  KeyU: { code: 0x3c },
  KeyV: { code: 0x2a },
  KeyW: { code: 0x1d },
  KeyX: { code: 0x22 },
  KeyY: { code: 0x35 },
  KeyZ: { code: 0x1a },

  // Digits
  Digit1: { code: 0x16 },
  Digit2: { code: 0x1e },
  Digit3: { code: 0x26 },
  Digit4: { code: 0x25 },
  Digit5: { code: 0x2e },
  Digit6: { code: 0x36 },
  Digit7: { code: 0x3d },
  Digit8: { code: 0x3e },
  Digit9: { code: 0x46 },
  Digit0: { code: 0x45 },

  // Whitespace / symbols
  Space: { code: 0x29 },
  Enter: { code: 0x5a },
  Tab: { code: 0x0d },
  Backspace: { code: 0x66 },
  Escape: { code: 0x76 },

  Minus: { code: 0x4e },
  Equal: { code: 0x55 },
  BracketLeft: { code: 0x54 },
  BracketRight: { code: 0x5b },
  Backslash: { code: 0x5d },
  Semicolon: { code: 0x4c },
  Quote: { code: 0x52 },
  Comma: { code: 0x41 },
  Period: { code: 0x49 },
  Slash: { code: 0x4a },
  Backquote: { code: 0x0e },
}

/* -------------------------------------------------------------------------- */
/*  Modifier keys                                                             */
/* -------------------------------------------------------------------------- */

export const ModifierScanCodes: Record<string, ScanCode> = {
  ShiftLeft: { code: 0x12 },
  ShiftRight: { code: 0x59 },
  ControlLeft: { code: 0x14 },
  ControlRight: { prefix: 0xe0, code: 0x14 },
  AltLeft: { code: 0x11 },
  AltRight: { prefix: 0xe0, code: 0x11 },
  MetaLeft: { prefix: 0xe0, code: 0x1f },
  MetaRight: { prefix: 0xe0, code: 0x27 },
}

/* -------------------------------------------------------------------------- */
/*  Navigation cluster                                                        */
/* -------------------------------------------------------------------------- */

export const NavigationScanCodes: Record<string, ScanCode> = {
  ArrowUp: { prefix: 0xe0, code: 0x75 },
  ArrowDown: { prefix: 0xe0, code: 0x72 },
  ArrowLeft: { prefix: 0xe0, code: 0x6b },
  ArrowRight: { prefix: 0xe0, code: 0x74 },

  Home: { prefix: 0xe0, code: 0x6c },
  End: { prefix: 0xe0, code: 0x69 },
  PageUp: { prefix: 0xe0, code: 0x7d },
  PageDown: { prefix: 0xe0, code: 0x7a },
  Insert: { prefix: 0xe0, code: 0x70 },
  Delete: { prefix: 0xe0, code: 0x71 },
}

/* -------------------------------------------------------------------------- */
/*  Function keys                                                             */
/* -------------------------------------------------------------------------- */

export const FunctionScanCodes: Record<string, ScanCode> = {
  F1: { code: 0x05 },
  F2: { code: 0x06 },
  F3: { code: 0x04 },
  F4: { code: 0x0c },
  F5: { code: 0x03 },
  F6: { code: 0x0b },
  F7: { code: 0x83 },
  F8: { code: 0x0a },
  F9: { code: 0x01 },
  F10: { code: 0x09 },
  F11: { code: 0x78 },
  F12: { code: 0x07 },
}

/* -------------------------------------------------------------------------- */
/*  Utility lookup                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a KeyboardEvent.code-style identifier to a ScanCode.
 * Returns null if the key is unsupported.
 */
export function lookupScanCode(code: string): ScanCode | null {
  return (
    ScanCodes[code] ??
    ModifierScanCodes[code] ??
    NavigationScanCodes[code] ??
    FunctionScanCodes[code] ??
    null
  )
}
