import type { AppState, PcPowerTruth, PcPowerValue, SliceKey } from '../types'
import { commit } from '../state'

export const SLICE_POWER: SliceKey = 'power'
export const SLICE_POWER_PC: SliceKey = 'power.pc'

/**
 * Selector: raw truth for PC power.
 */
export function selectPcPower(state: AppState): PcPowerTruth {
  return state.power.pc
}

/**
 * Selector: conservative boolean used for gating behavior.
 * This preserves the (older) rule that UNKNOWN behaves like OFF when gating.
 */
export function selectPcIsPoweredOnConservative(state: AppState): boolean {
  const v = state.power.pc.value
  return v === 'on'
}

export type SetPcPowerArgs = {
  value: PcPowerValue
  changedAt?: number
  source?: string
}

/**
 * Owner mutator helper: set PC power truth.
 *
 * Composition guidance:
 * - Import and use this from the FrontPanel adapter (owner), not from consumers.
 */
export function setPcPowerTruth(args: SetPcPowerArgs) {
  commit(
    draft => {
      draft.power.pc = {
        value: args.value,
        changedAt: args.changedAt ?? Date.now(),
        source: args.source
      }
    },
    { changedSliceKeys: [SLICE_POWER_PC] }
  )
}
