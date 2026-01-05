// apps/web/src/components/panes/ps2KeyboardTest/PS2KeyboardTestPane.panePrefs.ts
import type { PanePrefsSpec } from '@/panes/registry'

export const panePrefsSpec: PanePrefsSpec = {
    id: 'ps2KeyboardTest',
    storagePrefix: 'kb:pane:ui:',
    propsKey: '__kbPaneUi',
    profileRevKey: '__kbPaneProfileRev',
}
