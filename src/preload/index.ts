import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopAPI } from '../shared/desktop'

const api: DesktopAPI = {
  createImport: (input) => ipcRenderer.invoke('akiya:createImport', input),
  inspectImport: (id) => ipcRenderer.invoke('akiya:inspectImport', id),
  cancelImport: (id) => ipcRenderer.invoke('akiya:cancelImport', id),
  listImports: () => ipcRenderer.invoke('akiya:listImports'),
  areaResults: (query) => ipcRenderer.invoke('akiya:areaResults', query),
}
contextBridge.exposeInMainWorld('openAkiya', api)
