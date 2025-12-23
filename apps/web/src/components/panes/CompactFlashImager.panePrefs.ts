// apps/web/src/components/panes/**/CfImagerPane.panePrefs.ts
import type { PanePrefsSpec } from '@/panes/registry'

export const panePrefsSpec: PanePrefsSpec = {
    id: 'cfImager',
    storagePrefix: 'cf:pane:ui:',
    propsKey: '__cfPaneUi',
    profileRevKey: '__cfPaneProfileRev',
}
