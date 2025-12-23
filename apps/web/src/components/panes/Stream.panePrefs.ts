// apps/web/src/components/panes/StreamPane.panePrefs.ts
import type { PanePrefsSpec } from '@/panes/registry'

export const panePrefsSpec: PanePrefsSpec = {
    id: 'stream',
    storagePrefix: 'stream:pane:ui:',
    propsKey: '__streamPaneUi',
    profileRevKey: '__streamPaneProfileRev',
}
