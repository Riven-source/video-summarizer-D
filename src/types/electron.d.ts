// Electron API 类型定义
export interface ElectronAPI {
  // 任务管理
  getTasks: () => Promise<any[]>
  addTask: (url: string) => Promise<{ success: boolean; taskId?: string; error?: string }>
  retryTask: (taskId: string) => Promise<{ success: boolean; taskId?: string; error?: string }>
  refreshTask: (taskId: string) => Promise<{ success: boolean; taskId?: string; error?: string }>
  deleteTask: (taskId: string) => Promise<{ success: boolean; error?: string }>
  clearAllTasks: () => Promise<{ success: boolean; error?: string }>
  onTaskUpdate: (callback: (task: any) => void) => () => void
  downloadTranscription: (taskId: string) => Promise<{ success: boolean; path?: string; error?: string }>
  openPath: (path: string) => Promise<boolean>
  openTranscriptionsFolder: () => Promise<{ success: boolean; path?: string; error?: string }>

  // Cookie 管理
  getCookiesFromChrome: (site: 'bilibili' | 'youtube') => Promise<{ success: boolean; error?: string }>
  importCookieFromPath: (site: 'bilibili' | 'youtube', filePath: string) => Promise<{ success: boolean; path?: string; size?: number; error?: string }>

  // 检查是否为 Electron 环境
  isElectron: boolean
}

// Window 接口扩展
declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}
