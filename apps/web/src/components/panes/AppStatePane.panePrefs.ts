// apps/web/src/components/panes/appState/AppStatePane.panePrefs.ts
import type { PanePrefsSpec } from '@/panes/registry'

export const panePrefsSpec: PanePrefsSpec = {
    id: 'appState',
    storagePrefix: 'as:pane:ui:',
    propsKey: '__asPaneUi',
    profileRevKey: '__asPaneProfileRev',
}
