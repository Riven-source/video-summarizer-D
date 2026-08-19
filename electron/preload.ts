/**
 * Electron 预加载脚本
 * 用于安全地暴露主进程 API 到渲染进程
 */

import { contextBridge, ipcRenderer } from 'electron'

// [TODO] 任务类型
interface Task {
  id: string
  url: string
  mode: string
  status: 'pending' | 'downloading' | 'transcribing' | 'completed' | 'error'
  progress: number
  error?: string
  title?: string
  summary?: string
  transcriptionPath?: string
  createdAt: number
  completedAt?: number
}

// [TODO] API 类型定义
export interface ElectronAPI {
  // 任务管理
  getTasks: () => Promise<Task[]>
  addTask: (url: string) => Promise<{ success: boolean; taskId?: string; error?: string }>
  retryTask: (taskId: string) => Promise<{ success: boolean; taskId?: string; error?: string }>
  refreshTask: (taskId: string) => Promise<{ success: boolean; taskId?: string; error?: string }>
  deleteTask: (taskId: string) => Promise<{ success: boolean; error?: string }>
  clearAllTasks: () => Promise<{ success: boolean; error?: string }>
  onTaskUpdate: (callback: (task: Task) => void) => () => void
  downloadTranscription: (taskId: string) => Promise<{ success: boolean; path?: string; error?: string }>
  openPath: (path: string) => Promise<boolean>
  openTranscriptionsFolder: () => Promise<{ success: boolean; error?: string }>
  
  // Cookie 管理
  getCookiesFromChrome: (site: 'bilibili' | 'youtube') => Promise<{ success: boolean; error?: string }>
  importCookieFromPath: (site: 'bilibili' | 'youtube', filePath: string) => Promise<{ success: boolean; path?: string; size?: number; error?: string }>

  // 检查是否为 Electron 环境
  isElectron: boolean
}

// [TODO] 注册预加载 API
const electronAPI: ElectronAPI = {
  // 任务管理
  getTasks: () => ipcRenderer.invoke('get-tasks'),
  
  addTask: (url) => ipcRenderer.invoke('add-task', url),
  
  retryTask: (taskId) => ipcRenderer.invoke('retry-task', taskId),
  
  onTaskUpdate: (callback) => {
    const handler = (_: Electron.IpcRendererEvent, task: Task) => callback(task)
    ipcRenderer.on('task-update', handler)
    return () => ipcRenderer.removeListener('task-update', handler)
  },
  
  downloadTranscription: (taskId) => ipcRenderer.invoke('download-transcription', taskId),

  deleteTask: (taskId) => ipcRenderer.invoke('delete-task', taskId),
  
  clearAllTasks: () => ipcRenderer.invoke('clear-all-tasks'),
  
  openPath: (path) => ipcRenderer.invoke('open-path', path),
  
  openTranscriptionsFolder: () => ipcRenderer.invoke('open-transcriptions-folder'),
  
  // Cookie 管理
  getCookiesFromChrome: (site) => ipcRenderer.invoke('get-cookies-from-chrome', site),
  importCookieFromPath: (site, filePath) => ipcRenderer.invoke('import-cookie-from-path', { site, filePath }),

  // 任务刷新
  refreshTask: (taskId) => ipcRenderer.invoke('refresh-task', taskId),
  
  // 标记为 Electron 环境
  isElectron: true,
}

// [TODO] 使用 contextBridge 暴露 API
contextBridge.exposeInMainWorld('electronAPI', electronAPI)
