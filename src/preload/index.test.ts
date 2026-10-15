import { expect, it, vi } from 'vitest'
const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn() },
}))
vi.mock('electron', () => electron)
it('exposes only approved domain operations through named IPC channels', async () => {
  await import('./index')
  const [name, api] = electron.contextBridge.exposeInMainWorld.mock.calls[0]
  expect(name).toBe('openAkiya')
  expect(Object.keys(api).sort()).toEqual([
    'areaResults',
    'cancelImport',
    'createImportRequest',
    'inspectImport',
    'inspectImportRequest',
    'listImports',
    'searchLocations',
  ])
  const input = {
    area: { center: { latitude: 35, longitude: 135 }, radiusKm: 5 },
    intent: 'import',
    idempotencyKey: 'key',
  }
  electron.ipcRenderer.invoke.mockResolvedValue({ result: { id: 'request-1' } })
  await expect(api.createImportRequest(input)).resolves.toEqual({
    id: 'request-1',
  })
  expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(
    'akiya:createImportRequest',
    input,
  )
  electron.ipcRenderer.invoke.mockResolvedValue({
    error: {
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'Idempotency key already belongs to different input',
      retryable: false,
    },
  })
  await expect(api.createImportRequest(input)).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
    retryable: false,
  })
})
