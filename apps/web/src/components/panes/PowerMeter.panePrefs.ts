// apps/web/src/components/panes/**/PowerMeter.panePrefs.ts
import type { PanePrefsSpec } from '@/panes/registry'

export const panePrefsSpec: PanePrefsSpec = {
    id: 'powerMeter',
    storagePrefix: 'pm:pane:ui:',
    propsKey: '__pmPaneUi',
    profileRevKey: '__pmPaneProfileRev',
}
