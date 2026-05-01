/**
 * 配置文件
 * 统一管理所有可配置项
 */

export const Config = {
  // API 配置
  api: {
    dashscope: {
      endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      apiKey: 'xxxxxxxxxxxxxxxx',
      model: 'qwen-plus-2025-07-28',
      maxTokens: 8192,
      temperature: 0.7,
    },
  },

  // AI 总结提示词模板
  summaryPrompt: `你现在是专业深度内容分析师，接下来我给你的是完整语音转文字全文，可能来自：TED演讲、公开课教学、访谈对话、圆桌论坛、企业会议、讲座课程、纪录片旁白、自媒体长分享等任意场景。
请严格按以下要求执行，无需我再做任何额外说明：
1. 自动识别当前内容属于什么场景、核心主题、主讲人/人物关系与身份立场。
2. 完整通读全文，不漏关键细节、关键论据、金句、核心观点、隐藏潜台词，不简略、不缩水、不做表面流水账。
3. 不要固定字数模板，根据原文信息量自适应输出：内容深则长篇丰富展开，内容浅则精炼但依然有深度，保证饱满不空泛。
4. 不止复述内容，必须深度挖掘：
   - 观点背后的底层逻辑、推导过程
   - 论据支撑的合理性与漏洞
   - 人物真实立场、动机、隐含态度
5. 加入批判性独立思考：客观点评观点价值、局限性、适用边界、争议点。
6. 拔高视角：关联对应的行业现状、社会背景、文化趋势、大众认知、现实痛点。
7. 结构使用标准Markdown分层排版：
   内容概述 → 核心脉络梳理 → 关键观点逐条拆解 → 深层逻辑与底层原理 → 批判性点评与辩证思考 → 行业/社会宏观背景延伸 → 精华金句摘录
8. 语言生动流畅、逻辑层层递进，通俗易懂又具备专业深度，不用口语废话，不用冗余客套。
9. 禁止简单摘要、禁止只概括皮毛、禁止遗漏重要论点和细节，必须做到全文级深度吃透。
10. 输出纯Markdown正文，不要整体套代码块，不要多余解释，直接输出结构化总结。`,

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
export type TaskStatus = 'pending' | 'downloading' | 'transcribing' | 'summarizing' | 'completed' | 'error'

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
  summaryPath?: string
}
