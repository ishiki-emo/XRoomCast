/**
 * 画面(renderer)に渡す窓口。画面からは Node.js を触らせず、ここで決めた操作だけを呼べるようにする
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('bridge', {
  state: () => ipcRenderer.invoke('state'),
  logs: () => ipcRenderer.invoke('logs'),
  saveUrl: (url: string) => ipcRenderer.invoke('save-url', url),
  forgetUrl: () => ipcRenderer.invoke('forget-url'),
  start: () => ipcRenderer.invoke('start'),
  stop: () => ipcRenderer.invoke('stop'),
  openConsole: () => ipcRenderer.invoke('open-console'),
  onState: (callback: (state: unknown) => void) =>
    ipcRenderer.on('state', (_event, state: unknown) => callback(state)),
  onLog: (callback: (line: string) => void) =>
    ipcRenderer.on('log', (_event, line: string) => callback(line)),
});
