import { contextBridge, ipcRenderer } from 'electron'
import type { ApiError, DesktopAPI } from '../shared/desktop'

async function invoke<T>(channel: string, input: unknown): Promise<T> {
  const reply: { result?: T; error?: ApiError } = await ipcRenderer.invoke(
    channel,
    input,
  )
  if (reply.error)
    throw Object.assign(new Error(reply.error.message), reply.error)
  return reply.result as T
}
const api: DesktopAPI = {
  searchLocations: (query) => invoke('akiya:searchLocations', query),
  createImportRequest: (input) => invoke('akiya:createImportRequest', input),
  inspectImportRequest: (id) => invoke('akiya:inspectImportRequest', id),
  inspectImport: (id) => invoke('akiya:inspectImport', id),
  cancelImport: (id) => invoke('akiya:cancelImport', id),
  listImports: (input) => invoke('akiya:listImports', input),
  areaResults: (query) => invoke('akiya:areaResults', query),
}
contextBridge.exposeInMainWorld('openAkiya', api)
