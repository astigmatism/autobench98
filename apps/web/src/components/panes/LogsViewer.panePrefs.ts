// apps/web/src/components/panes/LogsViewer.panePrefs.ts
import type { PanePrefsSpec } from '@/panes/registry'

export const panePrefsSpec: PanePrefsSpec = {
    id: 'logs',
    storagePrefix: 'logs:pane:ui:',
    propsKey: '__logsPaneUi',
    profileRevKey: '__logsPaneProfileRev',
}
