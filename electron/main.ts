/**
 * Electron 主进程入口
 * [LOG] 模块加载
 */

import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, shell } from 'electron'
import { join } from 'path'
import { spawn, execSync } from 'child_process'
import * as fs from 'fs'
import { exec } from 'child_process'
import { promisify } from 'util'
import { Config } from '../src/config'

const execAsync = promisify(exec)

// [LOG] 日志格式函数
function log(level: 'LOG' | 'DEBUG' | 'WARN' | 'ERROR', module: string, message: string, context?: Record<string, unknown>) {
  const timestamp = new Date().toISOString().split('T')[1].slice(0, 8)
  const contextStr = context ? ` | ${JSON.stringify(context)}` : ''
  console.log(`[${timestamp}] [${level}] [${module}] ${message}${contextStr}`)
}

// [LOG] 获取日志目录
function getLogPath(): string {
  const logDir = app.isPackaged
    ? join(app.getPath('userData'), 'logs')
    : join(__dirname, '..', 'logs')

  // 确保日志目录存在
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true })
  }

  return join(logDir, 'app.log')
}

// [LOG] 写入日志文件
function writeLog(level: string, module: string, message: string, context?: Record<string, unknown>) {
  const logPath = getLogPath()
  const timestamp = new Date().toISOString()
  const contextStr = context ? ` | ${JSON.stringify(context)}` : ''
  const logLine = `[${timestamp}] [${level}] [${module}] ${message}${contextStr}\n`

  try {
    fs.appendFileSync(logPath, logLine)
  } catch (err) {
    console.error('[ERROR] [Logger] 写入日志文件失败:', err)
  }
}

// 全局变量
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null

// [LOG] Cookie 配置路径
const COOKIE_DIR = app.isPackaged
  ? join(app.getPath('userData'), 'cookies')
  : join(__dirname, '..', 'cookies')

// [LOG] 获取默认 Cookie 路径
function getDefaultCookiePath(site: string): string {
  // 确保目录存在（处理路径被误创建为文件的情况）
  try {
    const stats = fs.statSync(COOKIE_DIR)
    if (!stats.isDirectory()) {
      // 路径是文件，重命名为 .bak 并创建目录
      fs.renameSync(COOKIE_DIR, COOKIE_DIR + '.bak')
      fs.mkdirSync(COOKIE_DIR, { recursive: true })
    }
  } catch {
    // 路径不存在，创建目录
    fs.mkdirSync(COOKIE_DIR, { recursive: true })
  }
  return join(COOKIE_DIR, `${site}_cookies.txt`)
}

// [LOG] 网站域名映射
const SITE_DOMAINS: Record<string, string[]> = {
  bilibili: ['bilibili.com', 'b23.tv'],
  youtube: ['youtube.com', 'youtu.be'],
}

// [LOG] 从 Chrome 自动获取 Cookie
async function getCookiesFromChrome(site: 'bilibili' | 'youtube'): Promise<{ success: boolean; cookies?: string; error?: string }> {
  log('DEBUG', 'ChromeCookie', `开始从 Chrome 获取 ${site} Cookie`)

  try {
    const domains = SITE_DOMAINS[site]
    const chromeCookiePath = join(
      process.env.HOME || '',
      'Library/Application Support/Google/Chrome/Default/Cookies'
    )

    if (!fs.existsSync(chromeCookiePath)) {
      log('ERROR', 'ChromeCookie', 'Chrome Cookie 数据库不存在')
      return { success: false, error: 'Chrome Cookie 数据库不存在' }
    }

    // 创建临时目录
    const tempDir = join(COOKIE_DIR, 'temp')
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true })
    }
    const tempDbPath = join(tempDir, 'chrome_cookies_copy.db')

    // 复制 Cookie 数据库（避免锁定）
    fs.copyFileSync(chromeCookiePath, tempDbPath)
    log('DEBUG', 'ChromeCookie', 'Cookie 数据库已复制到临时目录')

    // 创建 Python 脚本文件（避免 shell 引号转义问题）
    const scriptPath = join(tempDir, 'extract_cookies.py')
    const domainsList = domains.map(d => `'${d}'`).join(', ')
    const pythonScriptContent = `
import sqlite3
import os
import sys

cookie_db = r"${tempDbPath.replace(/\\/g, '\\\\')}"

try:
    conn = sqlite3.connect(cookie_db)
    cursor = conn.cursor()
    
    domains = [${domainsList}]
    cookies = []
    
    for domain in domains:
        cursor.execute(
            "SELECT host_key, name, value, path, expires_utc, is_secure FROM cookies WHERE host_key LIKE ? OR host_key LIKE ? ORDER BY host_key",
            (f"%{domain}", f"%.{domain}")
        )
        
        for row in cursor.fetchall():
            host, name, value, path, expires, secure = row
            expiry = int(expires / 1000000 - 11644473600) if expires > 0 else 0
            secure_str = "TRUE" if secure else "FALSE"
            # 正确转义值：替换换行符和制表符，避免破坏 Netscape 格式
            value = value.replace('\\r\\n', '\\n').replace('\\n', '\\\\n').replace('\\t', '\\\\t')
            cookies.append(f"{host}\\tTRUE\\t{path}\\t{secure_str}\\t{expiry}\\t{name}\\t{value}")
    
    conn.close()
    
    if cookies:
        print('\\n'.join(cookies))
    else:
        print('', end='')
        
except Exception as e:
    print(f"ERROR: {str(e)}", file=sys.stderr)
    sys.exit(1)
`

    fs.writeFileSync(scriptPath, pythonScriptContent, 'utf-8')
    log('DEBUG', 'ChromeCookie', `Python 脚本已写入: ${scriptPath}`)

    const { stdout, stderr } = await execAsync(`python3 "${scriptPath}"`, {
      timeout: 30000
    })

    // 清理临时文件
    try {
      fs.unlinkSync(scriptPath)
      fs.unlinkSync(tempDbPath)
    } catch (e) {}

    if (stderr && stderr.includes('ERROR:')) {
      log('ERROR', 'ChromeCookie', '读取 Cookie 失败', { error: stderr })
      return { success: false, error: stderr }
    }

    if (!stdout.trim()) {
      log('WARN', 'ChromeCookie', '未找到 Cookie，可能需要先登录网站')
      return { success: false, error: '未找到 Cookie，请先在 Chrome 中登录 ' + site }
    }

    // 添加 netscape cookie 格式头
    const cookieHeader = '# Netscape HTTP Cookie File\n# This file was generated by Video Summarizer\n\n'
    const cookies = cookieHeader + stdout

    // 保存 Cookie 到文件
    const cookiePath = getDefaultCookiePath(site)
    fs.writeFileSync(cookiePath, cookies, 'utf-8')
    log('LOG', 'ChromeCookie', `Cookie 已保存到 ${cookiePath}`, { size: cookies.length })

    return { success: true, cookies }

  } catch (err) {
    log('ERROR', 'ChromeCookie', '获取 Cookie 异常', { error: String(err) })
    return { success: false, error: String(err) }
  }
}

// [DEBUG] 获取带 SSL 证书的环境变量
function getSpawnEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  
  // 确保 PATH 包含 ffmpeg 所在目录（pipx 隔离环境需要）
  const ffmpegDir = '/opt/homebrew/bin'
  const currentPath = env.PATH || ''
  if (!currentPath.includes(ffmpegDir)) {
    env.PATH = `${ffmpegDir}:${currentPath}`
  }
  
  // 设置 SSL 证书文件路径（修复 macOS Python SSL 问题）
  const certPaths = [
    '/opt/homebrew/opt/certifi/lib/python3.13/site-packages/certifi/cacert.pem',
    '/opt/homebrew/lib/python3.13/site-packages/certifi/cacert.pem',
    '/opt/homebrew/etc/openssl@3/cert.pem',
  ]
  for (const certPath of certPaths) {
    if (fs.existsSync(certPath)) {
      env.SSL_CERT_FILE = certPath
      env.REQUESTS_CA_BUNDLE = certPath
      break
    }
  }
  return env
}

// [DEBUG] 检查命令行参数
const isDev = process.env.NODE_ENV !== 'production' && !app.isPackaged

log('LOG', 'Main', 'Electron 应用启动', { version: app.getVersion(), isDev, isPackaged: app.isPackaged })
writeLog('LOG', 'Main', 'Electron 应用启动', { version: app.getVersion(), isDev, isPackaged: app.isPackaged })

// [LOG] 创建主窗口
function createWindow() {
  log('LOG', 'Main', '开始创建主窗口')

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Video Summarizer D',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  })

  // [LOG] 窗口创建成功
  log('LOG', 'Main', '主窗口创建成功', { width: 1200, height: 800 })
  writeLog('LOG', 'Main', '主窗口创建成功')

  // 窗口准备好后显示（避免白屏闪烁）
  mainWindow.once('ready-to-show', () => {
    // [LOG] 窗口准备好显示
    log('LOG', 'Main', '窗口 ready-to-show')
    mainWindow?.show()
  })

  // 加载页面
  if (process.env.VITE_DEV_SERVER_URL) {
    // [DEBUG] 开发模式：加载 Vite 开发服务器
    log('DEBUG', 'Main', `加载开发服务器: ${process.env.VITE_DEV_SERVER_URL}`)
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    // [LOG] 生产模式：加载打包后的文件
    log('LOG', 'Main', '加载生产构建文件')
    mainWindow.loadFile(join(__dirname, '../dist/index.html'))
  }

  // [DEBUG] 窗口关闭事件
  mainWindow.on('closed', () => {
    log('DEBUG', 'Main', '主窗口关闭')
    mainWindow = null
  })

  // [DEBUG] 渲染进程崩溃
  mainWindow.webContents.on('render-process-gone', (_, details) => {
    log('ERROR', 'Main', '渲染进程崩溃', { reason: details.reason })
    writeLog('ERROR', 'Main', '渲染进程崩溃', { reason: details.reason })
  })

  // [DEBUG] 控制台消息来自渲染进程
  mainWindow.webContents.on('console-message', (_, level, message, line, sourceId) => {
    const levels = ['DEBUG', 'INFO', 'WARN', 'ERROR']
    const logLevel = levels[level] || 'DEBUG'
    if (logLevel !== 'DEBUG') {
      log(logLevel as 'LOG' | 'WARN' | 'ERROR', 'Renderer', message, { line, sourceId })
    }
  })
}

// [LOG] 创建系统托盘
function createTray() {
  // [LOG] 创建托盘图标（使用空白图标作为占位）
  const icon = nativeImage.createEmpty()
  tray = new Tray(icon)

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        mainWindow?.show()
        mainWindow?.focus()
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.quit()
      },
    },
  ])

  tray.setToolTip('Video Summarizer D')
  tray.setContextMenu(contextMenu)

  // [LOG] 托盘点击事件
  tray.on('click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })

  log('LOG', 'Main', '系统托盘创建成功')
  writeLog('LOG', 'Main', '系统托盘创建成功')
}

// [DEBUG] 检测网站类型
function detectSite(url: string): 'bilibili' | 'youtube' | 'other' {
  if (url.includes('bilibili.com') || url.includes('b23.tv')) {
    return 'bilibili'
  }
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    return 'youtube'
  }
  return 'other'
}

// [DEBUG] 获取 Cookie 文件路径
function getCookiePath(url: string): string | null {
  const site = detectSite(url)
  if (site === 'other') return null
  
  const cookiePath = getDefaultCookiePath(site)
  if (fs.existsSync(cookiePath)) {
    return cookiePath
  }
  return null
}

// [DEBUG] IPC 通道注册
function setupIPC() {
  log('DEBUG', 'IPC', '开始注册 IPC 通道')
  writeLog('DEBUG', 'IPC', '开始注册 IPC 通道')

  // [DEBUG] 下载视频 IPC
  ipcMain.handle('download-video', async (event, { url, mode, outputPath }) => {
    log('DEBUG', 'IPC', '收到下载请求', { url, mode, outputPath })
    writeLog('DEBUG', 'IPC', '收到下载请求', { url, mode })

    // [DEBUG] 检测网站类型和 Cookie
    const site = detectSite(url)
    const cookiePath = getCookiePath(url)
    log('DEBUG', 'IPC', '网站检测结果', { site, hasCookie: !!cookiePath, cookiePath })

    return await downloadVideo(url, mode, outputPath, cookiePath, (progress) => {
      // [DEBUG] 发送下载进度到渲染进程
      mainWindow?.webContents.send('download-progress', progress)
    })
  })

  // [DEBUG] 选择本地文件 IPC
  ipcMain.handle('select-file', async () => {
    log('DEBUG', 'IPC', '收到选择文件请求')
    const { dialog } = await import('electron')
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      filters: [
        { name: '视频文件', extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v'] },
      ],
    })

    log('DEBUG', 'IPC', '文件选择结果', { canceled: result.canceled, filePaths: result.filePaths })
    return result
  })

  // [DEBUG] yt-dlp 路径检查 IPC
  ipcMain.handle('check-ytdlp', async () => {
    return await checkYtDlp()
  })

  // [DEBUG] 读取 Cookie 文件 IPC
  ipcMain.handle('read-cookie-file', async (_, site: 'bilibili' | 'youtube') => {
    log('DEBUG', 'IPC', '读取 Cookie 文件', { site })
    
    const cookiePath = getDefaultCookiePath(site)
    const altCookiePath = cookiePath.replace('_cookies.txt', '.txt')
    
    // 尝试多个可能的路径
    const possiblePaths = [cookiePath, altCookiePath]
    
    for (const path of possiblePaths) {
      if (fs.existsSync(path)) {
        log('LOG', 'IPC', 'Cookie 文件存在', { path })
        const content = fs.readFileSync(path, 'utf-8')
        return { 
          success: true, 
          path,
          exists: true,
          content: content.substring(0, 500) // 只返回前 500 字符用于验证
        }
      }
    }
    
    log('WARN', 'IPC', 'Cookie 文件不存在', { site, expectedPath: cookiePath })
    return { success: true, exists: false, path: cookiePath }
  })

  // [DEBUG] 写入 Cookie 文件 IPC
  ipcMain.handle('write-cookie-file', async (_, { site, content }: { site: 'bilibili' | 'youtube', content: string }) => {
    log('DEBUG', 'IPC', '写入 Cookie 文件', { site })
    
    try {
      const cookiePath = getDefaultCookiePath(site)
      fs.writeFileSync(cookiePath, content, 'utf-8')
      log('LOG', 'IPC', 'Cookie 文件已保存', { path: cookiePath, size: content.length })
      return { success: true, path: cookiePath }
    } catch (err) {
      log('ERROR', 'IPC', 'Cookie 文件写入失败', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  // [DEBUG] 从 Chrome 自动获取 Cookie IPC
  ipcMain.handle('get-cookies-from-chrome', async (_, site: 'bilibili' | 'youtube') => {
    log('DEBUG', 'IPC', '收到从 Chrome 获取 Cookie 请求', { site })
    return await getCookiesFromChrome(site)
  })

  // [DEBUG] 从外部路径导入 Cookie IPC
  ipcMain.handle('import-cookie-from-path', async (_, { site, filePath }: { site: 'bilibili' | 'youtube', filePath: string }) => {
    log('DEBUG', 'IPC', '收到导入 Cookie 请求', { site, filePath })
    
    try {
      // 检查源文件是否存在
      if (!fs.existsSync(filePath)) {
        log('ERROR', 'IPC', 'Cookie 源文件不存在', { filePath })
        return { success: false, error: `文件不存在: ${filePath}` }
      }
      
      // 读取源文件内容
      const content = fs.readFileSync(filePath, 'utf-8')
      
      // 保存到应用目录
      const cookiePath = getDefaultCookiePath(site)
      fs.writeFileSync(cookiePath, content, 'utf-8')
      
      log('LOG', 'IPC', 'Cookie 导入成功', { site, source: filePath, target: cookiePath, size: content.length })
      return { success: true, path: cookiePath, size: content.length }
    } catch (err) {
      log('ERROR', 'IPC', 'Cookie 导入失败', { error: String(err) })
      return { success: false, error: String(err) }
    }
  })

  // [DEBUG] 读取本地文件为 ArrayBuffer（供渲染进程创建 Blob URL）
  ipcMain.handle('read-file-arraybuffer', async (_, filePath: string) => {
    log('DEBUG', 'IPC', '收到读取文件请求', { filePath })
    writeLog('DEBUG', 'IPC', '读取文件为 ArrayBuffer', { filePath })

    return new Promise((resolve) => {
      // 根据扩展名确定 MIME 类型
      const ext = filePath.split('.').pop()?.toLowerCase() || ''
      const mimeTypes: Record<string, string> = {
        mp4: 'video/mp4',
        mkv: 'video/x-matroska',
        webm: 'video/webm',
        avi: 'video/x-msvideo',
        mov: 'video/quicktime',
        m4v: 'video/x-m4v',
        m4a: 'audio/mp4',
      }
      const mimeType = mimeTypes[ext] || 'application/octet-stream'

      fs.readFile(filePath, (err, data) => {
        if (err) {
          log('ERROR', 'IPC', '读取文件失败', { filePath, error: err.message })
          writeLog('ERROR', 'IPC', '读取文件失败', { filePath, error: err.message })
          resolve({ success: false, error: `无法读取文件: ${err.message}` })
          return
        }

        // 返回 Uint8Array（可以被序列化通过 IPC）
        log('LOG', 'IPC', '文件读取成功', { filePath, size: data.length, mimeType })
        writeLog('LOG', 'IPC', '文件读取成功', { filePath, size: data.length, mimeType })
        resolve({ 
          success: true, 
          arrayBuffer: new Uint8Array(data),
          mimeType,
        })
      })
    })
  })

  log('DEBUG', 'IPC', 'IPC 通道注册完成')
  writeLog('DEBUG', 'IPC', 'IPC 通道注册完成')
}

// [TODO] 任务管理 IPC
const TASKS_FILE = join(app.getPath('userData'), 'tasks.json')

function loadTasks(): any[] {
  try {
    if (fs.existsSync(TASKS_FILE)) {
      return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'))
    }
  } catch (e) {}
  return []
}

function saveTasks(tasks: any[]) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2))
}

function updateTask(task: any) {
  const tasks = loadTasks()
  const index = tasks.findIndex((t: any) => t.id === task.id)
  if (index >= 0) {
    tasks[index] = task
  } else {
    // prepend：新任务插入到数组最前（最新任务始终在最上）
    tasks.unshift(task)
  }
  saveTasks(tasks)
  mainWindow?.webContents.send('task-update', task)
}

// [TODO] IPC handlers
ipcMain.handle('get-tasks', async () => loadTasks())

ipcMain.handle('add-task', async (_, url: string) => {
  const task = {
    id: Date.now().toString(),
    url,
    mode: 'fast',
    status: 'pending',
    progress: 0,
    createdAt: Date.now(),
    retryCount: 0,
    maxRetries: 3,
  }
  updateTask(task)
  processTask(task).catch(console.error)
  return { success: true, taskId: task.id }
})

ipcMain.handle('retry-task', async (_, taskId: string) => {
  const tasks = loadTasks()
  const task = tasks.find((t: any) => t.id === taskId)
  if (!task) {
    return { success: false, error: '任务不存在' }
  }
  // 重置任务状态，增加重试计数
  task.status = 'pending'
  task.progress = 0
  task.error = undefined
  task.retryCount = (task.retryCount || 0) + 1
  updateTask(task)
  // 重新处理任务
  processTask(task).catch(console.error)
  return { success: true, taskId: task.id }
})

ipcMain.handle('refresh-task', async (_, taskId: string) => {
  const tasks = loadTasks()
  const task = tasks.find((t: any) => t.id === taskId)
  if (!task) {
    return { success: false, error: '任务不存在' }
  }
  // 如果任务已完成且有转写文案，直接进入AI总结阶段
  if (task.status === 'completed' && task.transcriptionPath) {
    task.status = 'summarizing'
    task.progress = 85
    task.error = undefined
    updateTask(task)
    // 直接调用AI总结阶段（重用processTask的一部分）
    // 这里我们暂时调用processTask，但processTask会从头开始。
    // 我们需要一个专门的函数来处理刷新逻辑。
    // 暂时先调用processTask，但后续优化。
    processTask(task).catch(console.error)
    return { success: true, taskId: task.id }
  } else {
    // 对于其他状态的任务，退回到重试逻辑
    task.status = 'pending'
    task.progress = 0
    task.error = undefined
    updateTask(task)
    processTask(task).catch(console.error)
    return { success: true, taskId: task.id }
  }
})

ipcMain.handle('download-summary', async (_, taskId: string) => {
  const tasks = loadTasks()
  const task = tasks.find((t: any) => t.id === taskId)
  if (!task || !task.summaryPath) {
    return { success: false, error: 'Summary not found' }
  }
  shell.showItemInFolder(task.summaryPath)
  return { success: true, path: task.summaryPath }
})

ipcMain.handle('download-transcription', async (_, taskId: string) => {
  const tasks = loadTasks()
  const task = tasks.find((t: any) => t.id === taskId)
  if (!task || !task.transcriptionPath) {
    return { success: false, error: 'Transcription not found' }
  }
  shell.showItemInFolder(task.transcriptionPath)
  return { success: true, path: task.transcriptionPath }
})

ipcMain.handle('open-path', async (_, path: string) => {
  shell.openPath(path)
  return true
})

// [DEBUG] 打开总结文件夹 IPC
ipcMain.handle('open-summaries-folder', async () => {
  const summaryDir = join(app.getPath('userData'), 'summaries')
  if (!fs.existsSync(summaryDir)) {
    fs.mkdirSync(summaryDir, { recursive: true })
  }
  shell.openPath(summaryDir)
  return { success: true, path: summaryDir }
})

// [DEBUG] 打开转写文案文件夹 IPC
ipcMain.handle('open-transcriptions-folder', async () => {
  const transcriptionDir = join(app.getPath('userData'), 'transcriptions')
  if (!fs.existsSync(transcriptionDir)) {
    fs.mkdirSync(transcriptionDir, { recursive: true })
  }
  shell.openPath(transcriptionDir)
  return { success: true, path: transcriptionDir }
})

// [DEBUG] 删除任务 IPC
ipcMain.handle('delete-task', async (_, taskId: string) => {
  log('DEBUG', 'IPC', '删除任务', { taskId })
  
  try {
    // 加载任务列表
    const tasks = loadTasks()
    const task = tasks.find((t: any) => t.id === taskId)
    
    if (!task) {
      return { success: false, error: '任务不存在' }
    }
    
    // 删除临时文件（如果存在）
    const tempDir = join(app.getPath('userData'), 'temp', `task_${taskId}`)
    if (fs.existsSync(tempDir)) {
      try {
        const files = fs.readdirSync(tempDir)
        for (const file of files) {
          fs.unlinkSync(join(tempDir, file))
        }
        fs.rmdirSync(tempDir)
        log('DEBUG', 'IPC', '删除临时文件', { tempDir })
      } catch (e) {
        log('WARN', 'IPC', '删除临时文件失败', { error: String(e) })
      }
    }
    
    // 删除总结文件（如果存在）
    if (task.summaryPath && fs.existsSync(task.summaryPath)) {
      try {
        fs.unlinkSync(task.summaryPath)
        log('DEBUG', 'IPC', '删除总结文件', { path: task.summaryPath })
      } catch (e) {
        log('WARN', 'IPC', '删除总结文件失败', { error: String(e) })
      }
    }
    
    // 从任务列表中移除
    const newTasks = tasks.filter((t: any) => t.id !== taskId)
    saveTasks(newTasks)
    
    log('LOG', 'IPC', '任务已删除', { taskId })
    return { success: true }
  } catch (err) {
    log('ERROR', 'IPC', '删除任务失败', { error: String(err) })
    return { success: false, error: String(err) }
  }
})

// [DEBUG] 清除所有任务 IPC
ipcMain.handle('clear-all-tasks', async () => {
  log('DEBUG', 'IPC', '清除所有任务')
  
  try {
    // 清理所有临时文件
    const tempBaseDir = join(app.getPath('userData'), 'temp')
    if (fs.existsSync(tempBaseDir)) {
      try {
        const dirs = fs.readdirSync(tempBaseDir)
        for (const dir of dirs) {
          if (dir.startsWith('task_')) {
            const taskDir = join(tempBaseDir, dir)
            const files = fs.readdirSync(taskDir)
            for (const file of files) {
              fs.unlinkSync(join(taskDir, file))
            }
            fs.rmdirSync(taskDir)
          }
        }
        log('DEBUG', 'IPC', '已清理所有临时文件')
      } catch (e) {
        log('WARN', 'IPC', '清理临时文件失败', { error: String(e) })
      }
    }
    
    // 清空任务列表
    saveTasks([])
    
    log('LOG', 'IPC', '所有任务已清除')
    return { success: true }
  } catch (err) {
    log('ERROR', 'IPC', '清除任务失败', { error: String(err) })
    return { success: false, error: String(err) }
  }
})

// [TODO] 处理任务流程 - 真实实现
async function processTask(task: any) {
  const taskId = task.id
  const url = task.url
  const mode = task.mode
  const tempDir = join(app.getPath('userData'), 'temp', `task_${taskId}`)
  let audioPath = ''
  
  log('LOG', 'Task', '开始处理任务', { id: taskId, url, mode })
  
  // 如果任务已有转写文案，直接进入AI总结阶段
  if (task.transcriptionPath && fs.existsSync(task.transcriptionPath)) {
    log('LOG', 'Task', '使用现有转写文案', { transcriptionPath: task.transcriptionPath })
    try {
      const transcriptionText = fs.readFileSync(task.transcriptionPath, 'utf-8')
      // 直接跳转到AI总结阶段
      task.status = 'summarizing'
      task.progress = 85
      updateTask(task)
      await performAISummary(task, transcriptionText)
      return
    } catch (error) {
      log('ERROR', 'Task', '读取现有转写文案失败，回退到正常流程', { error: String(error) })
      // 继续正常流程
    }
  }
  
  // AI总结函数
  async function performAISummary(task: any, transcriptionText: string) {
    task.status = 'summarizing'
    task.progress = 85
    updateTask(task)
    log('LOG', 'Task', '阶段3: AI 总结 (Qwen)', { textLength: transcriptionText.length })

    const apiEndpoint = Config.api.dashscope.endpoint
    const apiKey = Config.api.dashscope.apiKey
    const modelName = Config.api.dashscope.model
    const maxTokens = Config.api.dashscope.maxTokens
    const temperature = Config.api.dashscope.temperature

    // 超长字幕截断
    const MAX_PROMPT_CHARS = 60000
    const truncatedText = transcriptionText.length > MAX_PROMPT_CHARS
      ? transcriptionText.substring(0, MAX_PROMPT_CHARS) + '\n\n[内容过长，已截断...]'
      : transcriptionText

    const summaryPrompt = Config.summaryPrompt + '\n\n# ' + (task.title || '视频总结') + '\n\n## 视频字幕内容：\n' + truncatedText

    const apiResponse = await fetch(apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: 'user', content: summaryPrompt }],
        max_tokens: maxTokens,
        temperature: temperature
      })
    })

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text()
      log('ERROR', 'Task', 'Qwen API 调用失败', { status: apiResponse.status, error: errorText })
      throw new Error(`AI 总结失败: ${apiResponse.status} - ${errorText}`)
    }

    const apiData: any = await apiResponse.json()
    // OpenAI兼容格式响应
    const summaryContent = apiData.choices?.[0]?.message?.content || transcriptionText
    
    log('LOG', 'Task', 'AI 总结完成', { summaryLength: summaryContent.length })
    
    // ==================== 阶段4: 保存文件 ====================
    task.progress = 95
    updateTask(task)
    
    // 清理 summaryContent 中的代码块标记
    let cleanContent = summaryContent
    // 移除 ```markdown 或 ``` 开头的行
    cleanContent = cleanContent.replace(/^```markdown\s*$/gm, '')
    cleanContent = cleanContent.replace(/^```\s*$/gm, '')
    cleanContent = cleanContent.replace(/^```md\s*$/gm, '')
    cleanContent = cleanContent.trim()
    
    const summaryDir = join(app.getPath('userData'), 'summaries')
    if (!fs.existsSync(summaryDir)) {
      fs.mkdirSync(summaryDir, { recursive: true })
    }
    
    // 使用视频标题 + 任务 ID 作为文件名（清理特殊字符，确保唯一性）
    const safeTitle = (task.title || '视频总结').replace(/[\/\\:*?"<>|]/g, ' ').trim().substring(0, 60)
    const summaryFileName = `${task.id}_${safeTitle || '视频总结'}.md`
    const summaryPath = join(summaryDir, summaryFileName)
    
    let fullSummary;
    if (cleanContent.startsWith('# ')) {
      const lines = cleanContent.split('\n');
      const titleLine = lines[0];
      const rest = lines.slice(1).join('\n');
      fullSummary = `${titleLine}\n\n> 生成时间: ${new Date().toLocaleString('zh-CN')}\n\n${rest}`;
    } else {
      fullSummary = `# ${task.title || '视频总结'}\n\n> 生成时间: ${new Date().toLocaleString('zh-CN')}\n\n---\n\n${cleanContent}`;
    }
    
    fs.writeFileSync(summaryPath, fullSummary, 'utf-8')
    log('LOG', 'Task', '总结文件已保存', { path: summaryPath, videoTitle: task.title })
    
    // ==================== 阶段5: 清理临时文件 ====================
    // 刷新任务无需清理临时文件
    
    // ==================== 完成 ====================
    task.status = 'completed'
    task.progress = 100
    task.summary = fullSummary
    task.summaryPath = summaryPath
    task.completedAt = Date.now()
    updateTask(task)
    
    log('LOG', 'Task', '任务完成', { id: task.id, summaryPath })
  }
  
  try {
    // 确保临时目录存在
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true })
    }
    
    // ==================== 阶段1: 下载音频 ====================
    task.status = 'downloading'
    task.progress = 5
    updateTask(task)
    
    log('LOG', 'Task', '阶段1: 下载音频', { url })
    
    const site = detectSite(url)
    const cookiePath = getCookiePath(url)
    
    // 构建 yt-dlp 参数（使用 pipx 安装的版本）
    const pipxPath = '/Users/mickey/.local/bin/yt-dlp'
    const ytDlpPath = fs.existsSync(pipxPath) ? pipxPath : 'yt-dlp'
    const audioFileName = `audio_${taskId}.%(ext)s`
    const outputTemplate = join(tempDir, audioFileName)
    
    const args = [
      '--newline',
      '--no-playlist',
      '--no-write-thumbnail',
      '--no-check-certificate',
      // B站需要这些 headers 来避免 412 错误
      '--add-header', 'User-Agent:Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '--add-header', 'Referer:https://www.bilibili.com',
    ]
    
    // 根据模式选择质量
    if (mode === 'fast') {
      args.push('-f', 'bestaudio/best')
    } else if (mode === 'normal') {
      args.push('-f', 'bestaudio[ext=m4a]/bestaudio')
    } else {
      args.push('-f', 'bestaudio/best')
    }
    
    args.push(
      '--extract-audio',
      '--audio-format', 'm4a',
      '--audio-quality', '0',
      '-o', outputTemplate,
    )
    
    // B站使用 --cookies-from-browser 让 yt-dlp 自己解密 Chrome Cookie（绕过加密列问题）
    if (site === 'bilibili') {
      args.push('--cookies-from-browser', 'chrome')
      log('LOG', 'Task', `使用 Chrome Cookie (${site})`)
    }
    
    args.push(url)
    
    // 执行下载
    const downloadResult = await new Promise<{ success: boolean; filePath?: string; videoTitle?: string; error?: string }>((resolve) => {
      const env = getSpawnEnv()
      const proc = spawn(ytDlpPath, args, { env })
      let errorOutput = ''
      
      proc.stdout.on('data', (data) => {
        const line = data.toString()
        log('DEBUG', 'yt-dlp', line.trim())
        
        // 解析下载进度
        const progressMatch = line.match(/\[download\]\s+(\d+\.?\d*)%/)
        if (progressMatch) {
          const downloadProgress = Math.min(parseFloat(progressMatch[1]) * 0.4, 40)
          task.progress = 5 + downloadProgress
          updateTask(task)
        }
      })
      
      proc.stderr.on('data', (data) => {
        errorOutput += data.toString()
      })
      
      proc.on('close', async (code) => {
        if (code === 0) {
          // 查找下载的文件
          try {
            const files = fs.readdirSync(tempDir)
            const audioFile = files.find(f => f.startsWith('audio_') && (f.endsWith('.m4a') || f.endsWith('.mp3') || f.endsWith('.webm')))
            if (audioFile) {
              audioPath = join(tempDir, audioFile)
              log('LOG', 'Task', '音频下载完成', { audioPath })
              
              // 获取视频标题（对 B站 使用 --cookies-from-browser）
              let videoTitle = '视频总结'
              try {
                // 构建获取标题的参数数组
                const titleArgs: string[] = ['--print', '%(title)s', '--no-download', '--no-write-thumbnail', '--no-check-certificate', '--no-playlist']
                
                // B站使用 --cookies-from-browser
                if (site === 'bilibili') {
                  titleArgs.push('--cookies-from-browser', 'chrome')
                  log('LOG', 'Task', `获取标题使用 Chrome Cookie (${site})`)
                }
                titleArgs.push(url)
                
                // 使用 spawn 获取标题（避免 shell 引号转义问题）
                const titleResult = await new Promise<string>((resolve) => {
                  const proc = spawn(ytDlpPath, titleArgs, { env })
                  let stdout = ''
                  let stderr = ''
                  proc.stdout.on('data', (d) => { stdout += d.toString() })
                  proc.stderr.on('data', (d) => { stderr += d.toString() })
                  proc.on('close', (code) => {
                    if (code === 0 && stdout.trim()) {
                      resolve(stdout.trim())
                    } else {
                      log('WARN', 'Task', '获取标题失败', { code, stderr: stderr.substring(0, 200) })
                      resolve('')
                    }
                  })
                })
                
                videoTitle = (titleResult || '视频总结').replace(/[\/\\:*?"<>|]/g, ' ').trim()
                if (videoTitle.length > 100) videoTitle = videoTitle.substring(0, 100)
                log('LOG', 'Task', '获取到视频标题', { title: videoTitle, usedCookie: site === 'bilibili' })
              } catch (e) {
                log('WARN', 'Task', '获取视频标题失败，使用默认标题', { error: String(e) })
              }
              
              resolve({ success: true, filePath: audioPath, videoTitle })
            } else {
              resolve({ success: false, error: '未找到下载的音频文件' })
            }
          } catch (e) {
            resolve({ success: false, error: String(e) })
          }
        } else {
          log('ERROR', 'Task', '音频下载失败', { code, error: errorOutput })
          resolve({ success: false, error: errorOutput || `下载失败，错误码: ${code}` })
        }
      })
    })
    
    if (!downloadResult.success || !downloadResult.filePath) {
      throw new Error(downloadResult.error || '音频下载失败')
    }
    
    audioPath = downloadResult.filePath
    const videoTitle = downloadResult.videoTitle || '视频总结'
    
    // 更新任务标题
    task.title = videoTitle
    updateTask(task)
    
    // ==================== 阶段2: 音频转写 (FunASR) ====================
    task.status = 'transcribing'
    task.progress = 50
    updateTask(task)

    log('LOG', 'Task', '阶段2: 音频转写 (FunASR)', { audioPath })

    // ---------- 工具函数: 获取音频时长 ----------
    async function getAudioDuration(filePath: string): Promise<number> {
      try {
        const ffprobePath = '/opt/homebrew/bin/ffprobe'
        const { stdout } = await execAsync(
          `"${ffprobePath}" -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`
        )
        const duration = parseFloat(stdout.trim())
        log('LOG', 'Task', '音频时长', { filePath, duration: `${duration}s` })
        return isNaN(duration) ? 0 : duration
      } catch (err) {
        log('WARN', 'Task', '获取音频时长失败', { error: String(err) })
        return 0
      }
    }

    // ---------- 工具函数: FFmpeg 分段 ----------
    async function splitAudio(inputPath: string, segmentSecs: number): Promise<string[]> {
      // 验证输入文件
      if (!fs.existsSync(inputPath)) {
        throw new Error(`输入文件不存在: ${inputPath}`)
      }

      // 获取音频时长以估算分段数量
      let inputDuration = 0
      try {
        inputDuration = await getAudioDuration(inputPath)
      } catch (err) {
        log('WARN', 'Task', '获取输入音频时长失败，使用默认值', { error: String(err) })
        // 继续执行，使用默认值
      }

      const ffmpegPath = '/opt/homebrew/bin/ffmpeg'
      const outputPattern = join(tempDir, 'seg_%03d.m4a')

      // 清理旧的 seg_ 文件，避免残留
      try {
        const existing = fs.readdirSync(tempDir).filter(f => f.startsWith('seg_') && f.endsWith('.m4a'))
        for (const f of existing) {
          try { fs.unlinkSync(join(tempDir, f)) } catch (_) {}
        }
      } catch (_) {}

      // 使用更稳健的分段参数
      // 移除 -ss 0，避免与 segment 复用器冲突
      // 添加 -segment_time_delta 允许时间容差
      const args = [
        '-y',
        '-i', inputPath,
        '-c:a', 'aac',
        '-b:a', '128k',
        '-f', 'segment',
        '-segment_time', String(segmentSecs),
        '-segment_time_delta', '2.0', // 允许 ±2 秒的时间偏差
        '-segment_start_number', '0',
        '-reset_timestamps', '1',
        '-avoid_negative_ts', 'make_zero',
        outputPattern,
      ]

      log('LOG', 'Task', 'FFmpeg 分段命令', { 
        args: args.join(' '),
        inputDuration,
        segmentSecs,
        estimatedSegments: inputDuration > 0 ? Math.ceil(inputDuration / segmentSecs) : 'unknown'
      })

      // 根据分段数量调整超时时间（基于视频时长动态调整）
      const estimatedSegments = inputDuration > 0 ? Math.ceil(inputDuration / segmentSecs) : 10 // 默认10段
      
      // 根据视频时长动态调整每段超时时间
      let perSegmentTimeout
      if (inputDuration > 10800) { // 超过3小时的超长视频
        perSegmentTimeout = 480000 // 每段8分钟
      } else if (inputDuration > 7200) { // 2-3小时的长视频
        perSegmentTimeout = 300000 // 每段5分钟
      } else { // 2小时以下的视频
        perSegmentTimeout = 120000 // 每段2分钟
      }
      
      const timeoutMs = Math.max(300000, estimatedSegments * perSegmentTimeout) // 至少5分钟
      log('LOG', 'FFmpeg', '超时设置', { 
        inputDuration, 
        segmentSecs, 
        estimatedSegments, 
        perSegmentTimeoutMs: perSegmentTimeout,
        totalTimeoutMs: timeoutMs,
        timeoutMinutes: (timeoutMs / 60000).toFixed(1)
      })

      return new Promise((resolve, reject) => {
        const proc = spawn(ffmpegPath, args, {
          env: getSpawnEnv(),
          timeout: timeoutMs
        })

        let stderr = ''
        proc.stderr.on('data', (d) => { stderr += d.toString() })
        proc.on('close', (code) => {
          if (code === 0) {
            const files = fs.readdirSync(tempDir)
              .filter(f => f.startsWith('seg_') && f.endsWith('.m4a'))
              .sort()
              .map(f => join(tempDir, f))
            log('LOG', 'Task', '音频分段完成', { segments: files.length, files })
            resolve(files)
          } else {
            // 截取关键错误信息
            const lines = stderr.split('\n').filter(l => l.trim())
            const summary = lines.slice(-15).join(' | ')
            log('ERROR', 'FFmpeg', '分段失败', { code, stderr: summary })
            reject(new Error(`FFmpeg 分段失败 (${code}): ${summary}`))
          }
        })
        proc.on('error', (err) => {
          log('ERROR', 'FFmpeg', 'spawn 错误', { error: String(err) })
          reject(new Error(`FFmpeg 启动失败: ${err}`))
        })
      })
    }

    // ---------- 工具函数: 计算分段时长 ----------
    function calculateSegmentDuration(totalDuration: number): number {
      // 目标：每段不超过30分钟，总段数不超过10段，每段至少10分钟（除非总时长很短）
      const MAX_SEGMENT_DURATION = 1800 // 30分钟
      const MAX_SEGMENTS = 10
      const MIN_SEGMENT_DURATION = 600 // 10分钟

      if (totalDuration <= MAX_SEGMENT_DURATION) {
        return totalDuration // 无需分段
      }

      // 计算初始分段数量
      let segments = Math.ceil(totalDuration / MAX_SEGMENT_DURATION)
      if (segments > MAX_SEGMENTS) {
        segments = MAX_SEGMENTS
      }

      // 计算分段时长（向上取整到整分钟）
      let segmentDuration = Math.ceil(totalDuration / segments)
      // 确保分段时长不超过30分钟
      if (segmentDuration > MAX_SEGMENT_DURATION) {
        segmentDuration = MAX_SEGMENT_DURATION
      }
      // 确保分段时长不小于10分钟（除非总时长很短）
      if (segmentDuration < MIN_SEGMENT_DURATION && totalDuration > MIN_SEGMENT_DURATION) {
        segmentDuration = MIN_SEGMENT_DURATION
      }

      log('LOG', 'Task', '计算分段时长', { 
        totalDuration, 
        segments, 
        segmentDuration,
        maxSegments: MAX_SEGMENTS,
        maxSegmentDuration: MAX_SEGMENT_DURATION
      })
      return segmentDuration
    }

    // ---------- 工具函数: FunASR 单段转写 ----------
    async function transcribeSegment(segmentPath: string, segmentIndex: number, totalSegments: number): Promise<string> {
      const pythonScript = `
import sys
import os
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'

try:
    from funasr import AutoModel

    audio_path = r"${segmentPath.replace(/\\/g, '\\\\')}"
    print(f"[Segment ${segmentIndex}] Loading model...")
    
    # 尝试不同的模型配置以解决IndexError问题
    model = AutoModel(model="paraformer", vad_model="fsmn-vad", punc_model="ct-punc", model_hub="ms", trust_remote_code=True)
    print(f"[Segment ${segmentIndex}] Transcribing: {audio_path}")
    
    # 尝试多种参数组合以解决FunASR内部IndexError
    text = ""
    result = None
    error_messages = []
    
    # 参数组合尝试：首先尝试对长音频有效的参数（batch_size_s: 150），然后尝试其他组合
    # 针对FunASR内部IndexError的修复：较小的batch_size_s可以避免cif_predictor.py中的数组越界错误
    param_combinations = [
        {"batch_size_s": 150, "merge_vad": True, "merge_length_s": 15},  # 最可能成功的组合
        {"batch_size_s": 300, "merge_vad": True, "merge_length_s": 15},
        {"batch_size_s": 600, "merge_vad": True, "merge_length_s": 15},
        {"batch_size_s": 150, "merge_vad": False, "merge_length_s": 15},
        {"batch_size_s": 300, "merge_vad": False, "merge_length_s": 15},
    ]
    
    for param_idx, params in enumerate(param_combinations):
        try:
            print(f"[Segment ${segmentIndex}] 尝试参数组合 {param_idx + 1}/{len(param_combinations)}: {params}")
            result = model.generate(audio_path, 
                                   batch_size_s=params["batch_size_s"], 
                                   merge_vad=params["merge_vad"], 
                                   merge_length_s=params["merge_length_s"])
            print(f"[Segment ${segmentIndex}] 参数组合 {param_idx + 1} 成功")
            break
        except IndexError as idx_err:
            # 捕获特定的IndexError（cif_predictor.py中的错误）
            error_msg = f"参数组合 {param_idx + 1} IndexError: {str(idx_err)}"
            error_messages.append(error_msg)
            print(f"[Segment ${segmentIndex}] {error_msg}", file=sys.stderr)
            if param_idx == len(param_combinations) - 1:
                # 所有参数组合都失败了
                raise
            continue
        except Exception as gen_err:
            error_msg = f"参数组合 {param_idx + 1} 错误: {str(gen_err)}"
            error_messages.append(error_msg)
            print(f"[Segment ${segmentIndex}] {error_msg}", file=sys.stderr)
            if param_idx == len(param_combinations) - 1:
                # 所有参数组合都失败了
                raise
            continue
    
    # 处理多种可能的返回结果格式 - 修复数组越界错误
    if result is not None:
        try:
            # 检查是否是空张量（形状包含0）
            if hasattr(result, 'shape'):
                try:
                    import numpy as np
                    shape = result.shape
                    if 0 in shape:
                        print(f"[Segment ${segmentIndex}] 警告: 结果形状包含0: {shape}", file=sys.stderr)
                        # 空张量，直接返回空文本
                        print(f"SEGMENT_RESULT_${segmentIndex}:{text}")
                        sys.exit(0)
                except:
                    # 如果导入 numpy 失败或 shape 不可迭代，继续正常处理
                    pass
            
            # 尝试将结果视为可迭代对象
            if hasattr(result, '__len__'):
                try:
                    result_len = len(result)
                    if result_len > 0:
                        # 安全获取第一个元素
                        try:
                            first_item = result[0]
                        except (IndexError, TypeError) as idx_err:
                            # 捕获索引越界错误（例如空张量）
                            print(f"[Segment ${segmentIndex}] 警告: 无法访问result[0]: {idx_err}", file=sys.stderr)
                            first_item = None
                        
                        if first_item is not None:
                            # 如果是字典，尝试获取text字段
                            if isinstance(first_item, dict):
                                text = first_item.get("text", "")
                            else:
                                # 否则转换为字符串
                                text = str(first_item)
                    else:
                        # 空数组/列表/张量
                        print(f"[Segment ${segmentIndex}] 警告: 结果长度为0", file=sys.stderr)
                except TypeError:
                    # 对于0维张量，len()会失败
                    # 尝试直接访问或转换
                    try:
                        text = str(result)
                    except:
                        text = ""
            elif hasattr(result, 'get'):
                # 如果result本身是字典（某些版本可能返回单个字典）
                text = result.get("text", "")
            else:
                # 其他类型直接转字符串
                try:
                    text = str(result)
                except:
                    text = ""
        except Exception as e:
            print(f"[Segment ${segmentIndex}] 解析结果时出错: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc()
            text = ""
    
    print(f"SEGMENT_RESULT_${segmentIndex}:{text}")

except IndexError as idx_err:
    # 专门处理cif_predictor.py中的IndexError
    error_msg = f"FunASR内部IndexError: {str(idx_err)}"
    print(f"[Segment ${segmentIndex}] {error_msg}", file=sys.stderr)
    print(f"SEGMENT_RESULT_${segmentIndex}:")
    # 返回空文本而不是失败
    sys.exit(0)
except Exception as e:
    print(f"SEGMENT_ERROR_${segmentIndex}: {str(e)}", file=sys.stderr)
    import traceback
    traceback.print_exc()
    sys.exit(1)
`
      return new Promise((resolve, reject) => {
        const timeoutMs = 900000 // 每段最多 15 分钟
        const proc = spawn('/opt/homebrew/bin/python3', ['-c', pythonScript], {
          env: getSpawnEnv(),
          timeout: timeoutMs
        })
        let stdout = ''
        let stderr = ''

        proc.stdout.on('data', (data) => {
          stdout += data.toString()
          process.stdout.write(data)
        })
        proc.stderr.on('data', (data) => { stderr += data.toString() })

        proc.on('close', (code) => {
          if (code === 0) {
            const match = stdout.match(new RegExp(`SEGMENT_RESULT_${segmentIndex}:(.+)`,'s'))
            resolve(match ? match[1].trim() : '')
          } else {
            const errMatch = stderr.match(new RegExp(`SEGMENT_ERROR_${segmentIndex}: (.+)`))
            reject(new Error(errMatch ? errMatch[1] : `转写失败 (code: ${code})`))
          }
        })
      })
    }

    // ---------- 主流程: 检测 → 分段（需要时）→ 转写 ----------
    let segmentPaths: string[] = [audioPath]
    let transcriptionText = ''

    const audioDuration = await getAudioDuration(audioPath)
    const segmentDuration = calculateSegmentDuration(audioDuration)
    const needsSegmentation = audioDuration > segmentDuration
    
    log('LOG', 'Task', '检测音频时长', { 
      duration: audioDuration, 
      segmentDuration, 
      needsSegmentation,
      segmentCount: needsSegmentation ? Math.ceil(audioDuration / segmentDuration) : 1
    })

    if (needsSegmentation) {
      // 长视频：先分段再转写
      log('LOG', 'Task', '长视频分段处理', { duration: audioDuration, segmentDuration })
      segmentPaths = await splitAudio(audioPath, segmentDuration)

      // 删除原始音频文件（节省磁盘）
      try {
        fs.unlinkSync(audioPath)
        log('DEBUG', 'Task', '删除原始音频文件', { audioPath })
      } catch (_) {}

      if (segmentPaths.length === 0) {
        throw new Error('音频分段失败，未生成任何分段文件')
      }

      // 逐段转写并合并
      const segmentTexts: string[] = []
      for (let i = 0; i < segmentPaths.length; i++) {
        // 更新进度：50% + 35% * (当前段 / 总段数)
        task.progress = 50 + Math.round(35 * (i / segmentPaths.length))
        updateTask(task)
        log('LOG', 'Task', `转写分段 ${i + 1}/${segmentPaths.length}`, { segment: segmentPaths[i] })
        try {
          const segText = await transcribeSegment(segmentPaths[i], i, segmentPaths.length)
          segmentTexts.push(segText)
        } catch (segErr) {
          log('ERROR', 'Task', `分段 ${i + 1} 转写失败`, { error: String(segErr) })
          throw segErr
        }
        // 清理分段文件（节省磁盘）
        try { fs.unlinkSync(segmentPaths[i]) } catch (_) {}
      }
      transcriptionText = segmentTexts.join('\n')
    } else {
      // 短音频：直接转写
      log('LOG', 'Task', '短音频直接转写', { duration: audioDuration })
      const segText = await transcribeSegment(audioPath, 0, 1)
      transcriptionText = segText
      // 删除原始音频文件（节省磁盘）
      try {
        fs.unlinkSync(audioPath)
        log('DEBUG', 'Task', '删除原始音频文件', { audioPath })
      } catch (_) {}
    }

    if (!transcriptionText.trim()) {
      throw new Error('转写结果为空')
    }

    log('LOG', 'Task', '音频转写完成', { textLength: transcriptionText.length })

    // 保存转写文案到单独文件（使用任务 ID 确保唯一性）
    const transcriptionDir = join(app.getPath('userData'), 'transcriptions')
    if (!fs.existsSync(transcriptionDir)) {
      fs.mkdirSync(transcriptionDir, { recursive: true })
    }
    const safeTitleForTrans = videoTitle.replace(/[\/\\:*?"<>|]/g, ' ').trim().substring(0, 60)
    const transcriptionFileName = `${taskId}_${safeTitleForTrans || '视频文案'}_原文.txt`
    const transcriptionPath = join(transcriptionDir, transcriptionFileName)
    fs.writeFileSync(transcriptionPath, transcriptionText, 'utf-8')
    task.transcriptionPath = transcriptionPath
    log('LOG', 'Task', '转写文案已保存', { path: transcriptionPath })

    // ==================== 阶段3: AI 总结 (Qwen) ====================
    // performAISummary 函数内部已完成：阶段4保存文件 + 阶段5清理 + 完成状态更新
    
  } catch (error) {
    log('ERROR', 'Task', '任务失败', { id: taskId, error: String(error) })
    
    // 清理临时文件
    try {
      if (fs.existsSync(tempDir)) {
        const files = fs.readdirSync(tempDir)
        for (const file of files) {
          const filePath = join(tempDir, file)
          fs.unlinkSync(filePath)
        }
        fs.rmdirSync(tempDir)
      }
    } catch (cleanError) {
      log('WARN', 'Task', '清理临时文件失败', { error: String(cleanError) })
    }
    
    task.status = 'error'
    task.error = String(error)
    task.completedAt = Date.now()
    updateTask(task)
  }
}

// [LOG] yt-dlp 检查（使用 pipx 安装的版本）
async function checkYtDlp(): Promise<{ available: boolean; version?: string; error?: string }> {
  try {
    // 优先使用 pipx 安装的版本
    const pipxPath = '/Users/mickey/.local/bin/yt-dlp'
    const ytDlpPath = fs.existsSync(pipxPath) ? pipxPath : 'yt-dlp'
    
    const { stdout } = await execAsync(`"${ytDlpPath}" --version`, { timeout: 10000 })
    const version = stdout.trim()
    
    log('LOG', 'yt-dlp', 'yt-dlp 可用', { version, path: ytDlpPath })
    return { available: true, version }
  } catch (error) {
    log('WARN', 'yt-dlp', 'yt-dlp 不可用', { error: String(error) })
    return { available: false, error: String(error) }
  }
}

// [DEBUG] 获取视频信息（标题等）
async function getVideoInfo(url: string): Promise<{ title: string; filePath?: string }> {
  log('LOG', 'yt-dlp', '获取视频信息', { url })
  
  try {
    // 检测网站类型
    const site = detectSite(url)
    
    // 构建获取标题的参数
    const titleArgs = ['--print', '%(title)s', '--no-download', '--no-write-thumbnail', '--no-check-certificate', '--no-playlist']
    
    // B站使用 --cookies-from-browser
    if (site === 'bilibili') {
      titleArgs.push('--cookies-from-browser', 'chrome')
      log('LOG', 'yt-dlp', '获取标题使用 Chrome Cookie (B站)')
    }
    titleArgs.push(url)
    
    const pipxPath = '/Users/mickey/.local/bin/yt-dlp'
    const ytDlpPath = fs.existsSync(pipxPath) ? pipxPath : 'yt-dlp'
    
    const env = getSpawnEnv()
    
    // 使用 spawn 获取标题（避免 shell 引号转义问题）
    const titleResult = await new Promise<string>((resolve) => {
      const proc = spawn(ytDlpPath, titleArgs, { env })
      let stdout = ''
      let stderr = ''
      
      proc.stdout.on('data', (d) => { stdout += d.toString() })
      proc.stderr.on('data', (d) => { stderr += d.toString() })
      
      proc.on('close', (code) => {
        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim())
        } else {
          log('WARN', 'yt-dlp', '获取标题失败', { code, stderr: stderr.substring(0, 200) })
          resolve('')
        }
      })
    })
    
    let videoTitle = titleResult || '视频总结'
    // 清理标题中的非法文件名字符
    videoTitle = videoTitle.replace(/[\/\\:*?"<>|]/g, ' ').trim()
    // 限制标题长度
    if (videoTitle.length > 100) {
      videoTitle = videoTitle.substring(0, 100)
    }
    
    log('LOG', 'yt-dlp', '获取到视频标题', { title: videoTitle })
    
    return { title: videoTitle }
  } catch (error) {
    log('WARN', 'yt-dlp', '获取视频标题失败', { error: String(error) })
    return { title: '视频总结' }
  }
}

// [DEBUG] 下载视频
async function downloadVideo(
  url: string,
  mode: string,
  outputPath?: string,
  cookiePath?: string | null,
  onProgress?: (progress: number) => void
): Promise<{ success: boolean; filePath?: string; videoTitle?: string; error?: string }> {
  log('LOG', 'yt-dlp', '开始下载视频', { url, mode })
  
  try {
    const tempDir = outputPath || '/tmp/video-summarizer'
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true })
    }
    
    const outputTemplate = join(tempDir, 'video_%(epoch)s.%(ext)s')
    const args = [
      '--newline',
      '--no-playlist',
      '--no-write-thumbnail',
      '--no-check-certificate',
      '-f', 'bestaudio/best',
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '-o', outputTemplate,
      // B站需要这些 headers 来避免 412 错误
      '--add-header', 'User-Agent:Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '--add-header', 'Referer:https://www.bilibili.com',
    ]
    
    // B站使用 --cookies-from-browser 让 yt-dlp 自己解密 Chrome Cookie
    // YouTube 不需要 Cookie，文件 Cookie 方式读不了加密 Cookie
    const site = detectSite(url)
    if (site === 'bilibili') {
      args.push('--cookies-from-browser', 'chrome')
      log('LOG', 'yt-dlp', '使用 Chrome Cookie (B站)')
    }
    
    args.push(url)
    
    log('DEBUG', 'yt-dlp', '执行命令', { args })
    
    return new Promise((resolve) => {
      // 使用 pipx 安装的版本
      const pipxPath = '/Users/mickey/.local/bin/yt-dlp'
      const ytDlpPath = fs.existsSync(pipxPath) ? pipxPath : 'yt-dlp'
      
      const env = getSpawnEnv()
      const proc = spawn(ytDlpPath, args, { env })
      let errorOutput = ''
      
      proc.stdout.on('data', (data) => {
        const line = data.toString()
        log('DEBUG', 'yt-dlp', line.trim())
        
        // 解析进度
        const progressMatch = line.match(/\[download\]\s+(\d+\.?\d*)%/)
        if (progressMatch && onProgress) {
          onProgress(parseFloat(progressMatch[1]))
        }
      })
      
      proc.stderr.on('data', (data) => {
        errorOutput += data.toString()
      })
      
      proc.on('close', async (code) => {
        if (code === 0) {
          // 查找下载的文件
          const files = fs.readdirSync(tempDir)
          const videoFile = files.find(f => f.startsWith('video_') && f.endsWith('.mp3'))
          
          if (videoFile) {
            const filePath = join(tempDir, videoFile)
            
            // 获取视频标题
            const videoInfo = await getVideoInfo(url)
            
            log('LOG', 'yt-dlp', '视频下载完成', { filePath, title: videoInfo.title })
            resolve({ success: true, filePath, videoTitle: videoInfo.title })
          } else {
            resolve({ success: false, error: '未找到下载的文件' })
          }
        } else {
          log('ERROR', 'yt-dlp', '下载失败', { code, error: errorOutput })
          resolve({ success: false, error: errorOutput || `下载失败，错误码: ${code}` })
        }
      })
    })
  } catch (error) {
    log('ERROR', 'yt-dlp', '下载异常', { error: String(error) })
    return { success: false, error: String(error) }
  }
}

// [LOG] 应用准备就绪
app.whenReady().then(() => {
  log('LOG', 'Main', 'Electron app ready')
  writeLog('LOG', 'Main', 'Electron app ready')
  
  // 注册 IPC
  setupIPC()
  
  // 创建窗口
  createWindow()
  
  // 创建托盘
  createTray()
  
  // macOS 激活事件
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

// [LOG] 所有窗口关闭
app.on('window-all-closed', () => {
  log('DEBUG', 'Main', '所有窗口已关闭')
  writeLog('DEBUG', 'Main', '所有窗口已关闭')
  
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// [LOG] 应用退出
app.on('before-quit', () => {
  log('LOG', 'Main', '应用即将退出')
  writeLog('LOG', 'Main', '应用即将退出')
})

// [LOG] 应用退出完成
app.on('will-quit', () => {
  log('DEBUG', 'Main', 'Electron 应用退出')
  writeLog('DEBUG', 'Main', 'Electron 应用退出')
})
