// apps/web/src/components/panes/**/SerialPrinterPane.panePrefs.ts
import type { PanePrefsSpec } from '@/panes/registry'

export const panePrefsSpec: PanePrefsSpec = {
    id: 'serialPrinter',
    storagePrefix: 'sp:pane:ui:',
    propsKey: '__spPaneUi',
    profileRevKey: '__spPaneProfileRev',
}
