/**
 * 配置文件
 * 统一管理所有可配置项
 */

export const Config = {
  // 音频识别模型（paraformer + fsmn-vad + ct-punc）
  asr: {
    model: 'paraformer',
  },

  // 下载模式
  downloadMode: {
    deep: {
      name: '深度',
      description: '最佳质量',
      quality: 'best',
      format: 'mp4',
    },
    normal: {
      name: '普通',
      description: '平衡速度和质量',
      quality: 'best[height<=720]',
      format: 'mp4',
    },
    fast: {
      name: '极速',
      description: '仅下载音频',
      quality: 'bestaudio',
      format: 'm4a',
    },
  },

  // 应用信息
  app: {
    name: 'Video Summarizer',
    version: '1.0.5',
  },
}

export type DownloadMode = 'deep' | 'normal' | 'fast'
export type TaskStatus = 'pending' | 'downloading' | 'transcribing' | 'completed' | 'error'

export interface Task {
  id: string
  url: string
  mode: DownloadMode
  status: TaskStatus
  progress: number // 0-100
  error?: string
  title?: string
  summary?: string
  createdAt: number
  completedAt?: number
  retryCount?: number
  maxRetries?: number
  transcriptionPath?: string
}
