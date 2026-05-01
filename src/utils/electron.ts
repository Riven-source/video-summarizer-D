/**
 * Electron 环境检测工具
 */

import type { ElectronAPI } from '../types/electron'

// [TODO] 检查是否为 Electron 环境
export function isElectron(): boolean {
  return !!(window.electronAPI?.isElectron)
}

// [TODO] 获取 Electron API（带类型）
export function getElectronAPI(): ElectronAPI | undefined {
  return window.electronAPI
}
