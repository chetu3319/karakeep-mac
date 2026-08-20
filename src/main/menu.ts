import { BrowserWindow, Menu, MenuItemConstructorOptions, app, shell } from 'electron'
import { IPC } from '../shared/ipc'

// Menu click handlers don't get a window handed to them, so buildAppMenu
// takes a getter that resolves the window to push the toggle event to —
// the one the user actually triggered the shortcut in, falling back to
// whatever's focused/available.
export function buildAppMenu(getTargetWindow: () => BrowserWindow | null): Menu {
  const isMac = process.platform === 'darwin'

  function sendToRenderer(channel: string): void {
    const win = getTargetWindow()
    win?.webContents.send(channel)
  }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' as const } : { role: 'quit' as const }]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        { role: 'selectAll' as const }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' as const },
        { role: 'forceReload' as const },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        { role: 'resetZoom' as const },
        { role: 'zoomIn' as const },
        { role: 'zoomOut' as const },
        { type: 'separator' as const },
        {
          label: 'Hide/Show Sidebar',
          accelerator: 'Ctrl+Cmd+S',
          click: (): void => sendToRenderer(IPC.MENU_TOGGLE_SIDEBAR_EVENT)
        },
        {
          label: 'Hide/Show Bookmark List',
          accelerator: 'Ctrl+Cmd+L',
          click: (): void => sendToRenderer(IPC.MENU_TOGGLE_LIST_EVENT)
        },
        {
          label: 'Focus Mode',
          accelerator: 'Ctrl+Cmd+F',
          click: (): void => sendToRenderer(IPC.MENU_TOGGLE_FOCUS_MODE_EVENT)
        },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        ...(isMac
          ? [{ type: 'separator' as const }, { role: 'front' as const }]
          : [{ role: 'close' as const }])
      ]
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Open Karakeep Web App',
          click: async (): Promise<void> => {
            await shell.openExternal('https://karakeep.app')
          }
        }
      ]
    }
  ]

  return Menu.buildFromTemplate(template)
}
