/**
 * 主流程测试
 * 验证音频下载、分段转文字、AI总结功能
 */

import * as fs from 'fs'
import * as path from 'path'
import { spawn, execSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { Config } from '../src/config'

// 测试配置
const TEST_VIDEO_URL = process.env.TEST_VIDEO_URL || 'https://www.bilibili.com/video/BV1GJ411x7h7'
const TEST_OUTPUT_DIR = path.join(tmpdir(), 'video-summarizer-test-' + Date.now())
const LONG_VIDEO_URL = process.env.LONG_VIDEO_URL || '' // 5小时以上视频URL

// API配置
const API_ENDPOINT = Config.api.dashscope.endpoint
const API_KEY = Config.api.dashscope.apiKey
const MODEL_NAME = Config.api.dashscope.model

// 日志
function log(level: 'INFO' | 'PASS' | 'FAIL' | 'WARN', message: string, data?: any) {
  const timestamp = new Date().toISOString()
  const dataStr = data ? ` | ${JSON.stringify(data)}` : ''
  console.log(`[${timestamp}] [${level}] ${message}${dataStr}`)
}

// ============ 测试1: 音频下载 ============
async function testDownloadAudio(): Promise<{ success: boolean; audioPath?: string; duration?: number; error?: string }> {
  log('INFO', '=== 测试1: 音频下载 ===')

  const outputTemplate = path.join(TEST_OUTPUT_DIR, 'audio_test.%(ext)s')

  // 创建测试目录
  fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true })

  // 获取yt-dlp路径
  const ytdlpPath = path.join(__dirname, '..', '.venv', 'bin', 'yt-dlp')
  const actualYtdlpPath = fs.existsSync(ytdlpPath) ? ytdlpPath : 'yt-dlp'

  return new Promise((resolve) => {
    const process = spawn(actualYtdlpPath, [
      '--extract-audio',
      '--audio-format', 'm4a',
      '--audio-quality', '0',
      '-o', outputTemplate,
      '-f', 'bestaudio[ext=m4a]/bestaudio',
      TEST_VIDEO_URL
    ], { stdio: 'pipe' })

    let stderr = ''

    process.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    process.on('close', (code) => {
      if (code !== 0) {
        log('FAIL', '音频下载失败', { code, error: stderr.substring(0, 500) })
        resolve({ success: false, error: stderr.substring(0, 500) })
        return
      }

      // 查找下载的音频文件
      const files = fs.readdirSync(TEST_OUTPUT_DIR)
      const audioFile = files.find(f => f.startsWith('audio_test') && (f.endsWith('.m4a') || f.endsWith('.mp3') || f.endsWith('.webm')))

      if (!audioFile) {
        log('FAIL', '未找到音频文件')
        resolve({ success: false, error: 'Audio file not found' })
        return
      }

      const audioPath = path.join(TEST_OUTPUT_DIR, audioFile)
      const stats = fs.statSync(audioPath)

      // 获取音频时长
      let duration = 0
      try {
        const ffprobeOutput = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`, { encoding: 'utf-8' })
        duration = parseFloat(ffprobeOutput.trim())
      } catch (e) {
        log('WARN', '获取音频时长失败')
      }

      log('PASS', '音频下载成功', { audioPath, size: stats.size, duration: duration.toFixed(0) + 's' })
      resolve({ success: true, audioPath, duration })
    })
  })
}

// ============ 测试2: 音频分段与转写 ============
async function testSegmentationAndTranscription(audioPath: string, audioDuration: number): Promise<{ success: boolean; transcript?: string; segments?: string[]; error?: string }> {
  log('INFO', '=== 测试2: 音频分段与转写 ===')

  const MAX_SEGMENT_DURATION = 600 // 10分钟每段
  const segments: string[] = []

  // 计算需要多少段
  const segmentCount = Math.ceil(audioDuration / MAX_SEGMENT_DURATION)
  log('INFO', `需要分段数: ${segmentCount}`, { audioDuration, maxDuration: MAX_SEGMENT_DURATION })

  for (let i = 0; i < segmentCount; i++) {
    const startTime = i * MAX_SEGMENT_DURATION
    const endTime = Math.min((i + 1) * MAX_SEGMENT_DURATION, audioDuration)
    const segmentPath = path.join(TEST_OUTPUT_DIR, `segment_${i}.m4a`)

    log('INFO', `分段 ${i + 1}/${segmentCount}`, { startTime, endTime })

    // 提取音频片段
    try {
      execSync(`ffmpeg -y -i "${audioPath}" -ss ${startTime} -to ${endTime} -c copy "${segmentPath}"`, { stdio: 'pipe' })
    } catch (e) {
      log('FAIL', `分段 ${i + 1} 失败`)
      return { success: false, error: `Segment ${i} extraction failed` }
    }

    // 转写音频片段
    const transcript = await transcribeSegment(segmentPath, i)
    if (transcript) {
      segments.push(transcript)
    } else {
      log('WARN', `片段 ${i + 1} 转写失败`)
    }
  }

  const fullTranscript = segments.join('\n\n')
  log('PASS', '转写完成', { segments: segments.length, transcriptLength: fullTranscript.length })

  return { success: true, transcript: fullTranscript, segments }
}

// 转写单个音频片段
async function transcribeSegment(segmentPath: string, index: number): Promise<string | null> {
  const scriptPath = path.join(TEST_OUTPUT_DIR, `funasr_transcribe_${index}.py`)

  const pythonScript = `
import os
import sys
sys.path.insert(0, '${path.join(__dirname, '..', '.venv', 'lib', 'python3.11', 'site-packages')}')

from funasr import AutoModel

model = AutoModel(
    model="paraformer-zh",
    model_revision="v2.0.4",
    vad_model="fsmn-vad",
    vad_model_revision="v2.0.4",
    punc_model="ct-punc",
    punc_model_revision="v2.0.4",
    disable_update=True,
    ncpu=4
)

result = model.generate(
    input="${segmentPath.replace(/\\/g, '\\\\')}",
    batch_size_s=300,
    merge_vad=True,
    merge_length_s=15
)

if result and len(result) > 0:
    text = result[0].get('text', '')
    print(text)
else:
    print("")
`

  fs.writeFileSync(scriptPath, pythonScript)

  return new Promise((resolve) => {
    const process = spawn(path.join(__dirname, '..', '.venv', 'bin', 'python3'), [scriptPath], { stdio: 'pipe' })

    let stdout = ''
    let stderr = ''

    process.stdout.on('data', (data) => { stdout += data.toString() })
    process.stderr.on('data', (data) => { stderr += data.toString() })

    process.on('close', (code) => {
      fs.unlinkSync(scriptPath)
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim())
      } else {
        log('WARN', `片段转写失败`, { index, error: stderr.substring(0, 200) })
        resolve(null)
      }
    })
  })
}

// ============ 测试3: AI总结 ============
async function testAISummary(transcript: string): Promise<{ success: boolean; summary?: string; length?: number; error?: string }> {
  log('INFO', '=== 测试3: AI总结 ===')

  const summaryPath = path.join(TEST_OUTPUT_DIR, 'test_summary.md')

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 300000) // 5分钟超时

    const response = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: [{
          role: 'user',
          content: Config.summaryPrompt + '\n\n# 视频总结\n\n## 视频字幕内容：\n' + transcript
        }],
        max_tokens: Config.api.dashscope.maxTokens,
        temperature: Config.api.dashscope.temperature
      }),
      signal: controller.signal
    })

    clearTimeout(timeout)

    if (!response.ok) {
      const errorText = await response.text()
      log('FAIL', 'AI总结API调用失败', { status: response.status, error: errorText })
      return { success: false, error: errorText }
    }

    const data: any = await response.json()
    const summary = data.choices?.[0]?.message?.content || ''

    // 清理代码块标记
    let cleanSummary = summary
    cleanSummary = cleanSummary.replace(/^```markdown\s*$/gm, '')
    cleanSummary = cleanSummary.replace(/^```\s*$/gm, '')
    cleanSummary = cleanSummary.replace(/^```md\s*$/gm, '')

    fs.writeFileSync(summaryPath, cleanSummary, 'utf-8')

    log('PASS', 'AI总结完成', { length: cleanSummary.length, outputPath: summaryPath })

    // 验证输出质量
    const checks = validateSummary(cleanSummary)
    checks.forEach(check => {
      if (check.passed) {
        log('PASS', `质量检查: ${check.name}`)
      } else {
        log('WARN', `质量检查未通过: ${check.name}`, { detail: check.detail })
      }
    })

    return { success: true, summary: cleanSummary, length: cleanSummary.length }
  } catch (error: any) {
    log('FAIL', 'AI总结失败', { error: error.message })
    return { success: false, error: error.message }
  }
}

// 验证总结质量
function validateSummary(summary: string): Array<{ name: string; passed: boolean; detail?: string }> {
  const checks: Array<{ name: string; passed: boolean; detail?: string }> = []

  // 字数检查
  const charCount = summary.length
  checks.push({
    name: '字数要求(>6000字)',
    passed: charCount > 6000,
    detail: `${charCount} 字`
  })

  // Markdown结构检查
  const hasHeaders = /#{1,6}\s/.test(summary)
  checks.push({
    name: 'Markdown标题结构',
    passed: hasHeaders,
    detail: hasHeaders ? '存在' : '缺失'
  })

  // 内容深度检查
  const hasDeepContent = summary.length > 8000 && /分析|逻辑|观点|背景/.test(summary)
  checks.push({
    name: '内容深度',
    passed: hasDeepContent,
    detail: hasDeepContent ? '符合' : '不足'
  })

  return checks
}

// ============ 主测试流程 ============
async function runTests() {
  log('INFO', '========== 主流程测试开始 ==========')

  const results = {
    download: false,
    transcription: false,
    summary: false
  }

  // 测试1: 下载音频
  const downloadResult = await testDownloadAudio()
  results.download = downloadResult.success

  if (!downloadResult.success || !downloadResult.audioPath) {
    log('FAIL', '测试中止: 音频下载失败')
    return results
  }

  // 测试2: 分段转写
  let transcriptionResult
  if (downloadResult.duration && downloadResult.duration > 600) {
    // 超过10分钟的视频进行分段测试
    transcriptionResult = await testSegmentationAndTranscription(downloadResult.audioPath, downloadResult.duration)
  } else {
    // 短视频直接转写
    transcriptionResult = await testSegmentationAndTranscription(downloadResult.audioPath, downloadResult.duration || 0)
  }
  results.transcription = transcriptionResult.success

  if (!transcriptionResult.success || !transcriptionResult.transcript) {
    log('FAIL', '测试中止: 转写失败')
    return results
  }

  // 测试3: AI总结
  const summaryResult = await testAISummary(transcriptionResult.transcript)
  results.summary = summaryResult.success

  // 汇总结果
  log('INFO', '========== 测试结果汇总 ==========')
  log(results.download ? 'PASS' : 'FAIL', '音频下载', { success: results.download })
  log(results.transcription ? 'PASS' : 'FAIL', '分段转写', { success: results.transcription })
  log(results.summary ? 'PASS' : 'FAIL', 'AI总结', { success: results.summary })

  const allPassed = results.download && results.transcription && results.summary
  log(allPassed ? 'PASS' : 'FAIL', '全部测试', { results })

  // 清理
  log('INFO', '清理测试目录', { path: TEST_OUTPUT_DIR })
  // fs.rmSync(TEST_OUTPUT_DIR, { recursive: true, force: true })

  return results
}

// 运行测试
runTests().catch(console.error)

export { runTests, testDownloadAudio, testSegmentationAndTranscription, testAISummary }
