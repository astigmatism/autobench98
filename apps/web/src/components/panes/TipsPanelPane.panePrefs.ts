// apps/web/src/components/panes/TipsPanelPane.panePrefs.ts
import type { PanePrefsSpec } from '@/panes/registry'

export const panePrefsSpec: PanePrefsSpec = {
  id: 'tips',
  storagePrefix: 'tips:pane:ui:',
  propsKey: '__tipsPaneUi',
  profileRevKey: '__tipsPaneProfileRev',
}