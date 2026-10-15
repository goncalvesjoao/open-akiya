import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  utilityProcess,
  shell,
} from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdirSync } from 'node:fs'
import type { Operation, WorkerReply } from '../shared/desktop'
import { safeSourceUrl } from '../shared/geography'

app.setName('Open Akiya')

let window: BrowserWindow | null = null
let worker: Electron.UtilityProcess | null = null
let sequence = 0
let quitting = false
let readyToQuit = false
const pending = new Map<
  number,
  {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }
>()
const rendererPath = join(__dirname, '../renderer/index.html')
const developmentURL =
  !app.isPackaged &&
  process.env.ELECTRON_RENDERER_URL === 'http://127.0.0.1:5173'
    ? 'http://127.0.0.1:5173/'
    : null
const rendererURL = developmentURL ?? pathToFileURL(rendererPath).href

function call(operation: Operation, input?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!worker)
      return reject(new Error('Local worker unavailable. Restart Open Akiya.'))
    const id = ++sequence
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(
        new Error(
          'Local worker did not respond. Inspect the job before retrying.',
        ),
      )
    }, 15000)
    pending.set(id, { resolve, reject, timer })
    worker.postMessage({ id, operation, input })
  })
}
function startWorker() {
  worker = utilityProcess.fork(join(__dirname, 'worker.cjs'), [
    join(app.getPath('userData'), 'open-akiya.sqlite'),
  ])
  worker.on('message', (reply: WorkerReply) => {
    const request = pending.get(reply.id)
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(reply.id)
    if (reply.error) request.reject(new Error(reply.error))
    else request.resolve(reply.result)
  })
  worker.on('exit', () => {
    worker = null
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(
        new Error(
          'Local worker stopped. Reopen the app to recover interrupted imports.',
        ),
      )
    }
    pending.clear()
  })
}
function showWindow() {
  if (window && !window.isDestroyed()) {
    window.show()
    window.focus()
    return
  }
  window = new BrowserWindow({
    width: 1200,
    height: 850,
    minWidth: 640,
    minHeight: 500,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  const openExternal = (value: string) => {
    if (
      safeSourceUrl('fixture', value) ||
      value === 'https://www.openstreetmap.org/copyright'
    )
      void shell.openExternal(value)
  }
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== rendererURL) {
      event.preventDefault()
      openExternal(url)
    }
  })
  window.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  )
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      window?.hide()
    }
  })
  if (developmentURL) void window.loadURL(developmentURL)
  else void window.loadFile(rendererPath)
}

// Test-only data isolation is passed before Electron initializes its profile.
if (process.env.OPEN_AKIYA_TEST_DATA && !app.isPackaged)
  app.setPath('userData', process.env.OPEN_AKIYA_TEST_DATA)
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', showWindow)
  app.whenReady().then(() => {
    mkdirSync(app.getPath('userData'), { recursive: true })
    app.userAgentFallback = `OpenAkiya/${app.getVersion()} (+https://github.com/goncalvesjoao/open-akiya)`
    startWorker()
    const operations: Operation[] = [
      'createImport',
      'inspectImport',
      'cancelImport',
      'listImports',
      'areaResults',
    ]
    for (const operation of operations) {
      ipcMain.handle(`akiya:${operation}`, (event, input: unknown) => {
        if (
          !window ||
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          event.senderFrame.url !== rendererURL
        )
          throw new Error('Untrusted sender')
        return call(operation, input)
      })
    }
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'Open Akiya',
          submenu: [
            { label: 'Show Open Akiya', click: showWindow },
            {
              label: 'Quit Open Akiya',
              accelerator: 'CmdOrCtrl+Q',
              click: () => app.quit(),
            },
          ],
        },
        {
          label: 'Edit',
          submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'selectAll' },
          ],
        },
        {
          label: 'View',
          submenu: [
            { role: 'reload' },
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
          ],
        },
      ]),
    )
    showWindow()
  })
  app.on('activate', showWindow)
  app.on('before-quit', (event) => {
    quitting = true
    if (readyToQuit) return
    event.preventDefault()
    void call('shutdown')
      .catch(() => worker?.kill())
      .finally(() => {
        readyToQuit = true
        app.quit()
      })
  })
}
