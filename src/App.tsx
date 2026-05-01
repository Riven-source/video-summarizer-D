import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Download, FileText, CheckCircle, XCircle, Copy, Check, FolderOpen, Trash2, RefreshCw, Search } from 'lucide-react';
import { Task, TaskStatus } from './config';
import { isElectron } from './utils/electron';


// 状态图标组件
const StatusIcon: React.FC<{ status: TaskStatus }> = ({ status }) => {
  const icons = {
    pending: <div className="w-2.5 h-2.5 rounded-full bg-gray-300" />,
    downloading: <div className="w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse" />,
    transcribing: <div className="w-2.5 h-2.5 rounded-full bg-yellow-500 animate-pulse" />,
    summarizing: <div className="w-2.5 h-2.5 rounded-full bg-purple-500 animate-pulse" />,
    completed: <CheckCircle className="w-4 h-4 text-green-500" />,
    error: <XCircle className="w-4 h-4 text-red-500" />,
  };
  return icons[status];
};

// 状态文本
const statusText: Record<TaskStatus, string> = {
  pending: '等待中',
  downloading: '下载中',
  transcribing: '转写中',
  summarizing: '总结中',
  completed: '已完成',
  error: '失败',
};

function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [url, setUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearchInput, setShowSearchInput] = useState(false);
  const [refreshingTaskId, setRefreshingTaskId] = useState<string | null>(null);

  // [TODO] 加载任务列表
  const loadTasks = useCallback(async () => {
    if (isElectron() && window.electronAPI) {
      const loadedTasks = await window.electronAPI.getTasks();
      setTasks(loadedTasks);
    }
  }, []);

  // [TODO] 监听任务更新
  useEffect(() => {
    if (isElectron() && window.electronAPI) {
      const unsubscribe = window.electronAPI.onTaskUpdate((updatedTask) => {
        setTasks((prev) => {
          const index = prev.findIndex((t) => t.id === updatedTask.id);
          if (index >= 0) {
            const newTasks = [...prev];
            newTasks[index] = updatedTask;
            return newTasks;
          }
          return [...prev, updatedTask];
        });
      });
      loadTasks();
      return unsubscribe;
    }
  }, [loadTasks]);

  // [TODO] 提交任务
  const handleSubmit = async () => {
    if (!url.trim()) return;
    setSubmitting(true);

    try {
      if (isElectron() && window.electronAPI) {
        const result = await window.electronAPI.addTask(url.trim());
        if (result.success) {
          setShowModal(false);
          setUrl('');
          loadTasks();
        } else {
          alert(result.error || '添加任务失败');
        }
      }
    } finally {
      setSubmitting(false);
    }
  };

  // [TODO] 下载 MD 文件
  const handleDownload = async (taskId: string) => {
    if (isElectron() && window.electronAPI) {
      const result = await window.electronAPI.downloadSummary(taskId);
      if (result.success && result.path) {
        await window.electronAPI.openPath(result.path);
      } else {
        console.error('下载失败:', result.error);
      }
    }
  };

  // [TODO] 下载转写文案
  const handleDownloadTranscription = async (taskId: string) => {
    if (isElectron() && window.electronAPI) {
      const result = await window.electronAPI.downloadTranscription(taskId);
      if (result.success && result.path) {
        await window.electronAPI.openPath(result.path);
      } else {
        console.error('下载文案失败:', result.error);
      }
    }
  };

  // [TODO] 复制链接
  const handleCopyUrl = async (url: string) => {
    await navigator.clipboard.writeText(url);
  };

  // [TODO] 打开总结文件夹
  const handleOpenSummariesFolder = async () => {
    if (isElectron() && window.electronAPI) {
      await window.electronAPI.openSummariesFolder();
    }
  };

  // [TODO] 打开转写文案文件夹
  const handleOpenTranscriptionsFolder = async () => {
    if (isElectron() && window.electronAPI) {
      await window.electronAPI.openTranscriptionsFolder();
    }
  };

  // [TODO] 删除单个任务
  const handleDeleteTask = async (taskId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('确定删除此任务？')) return;
    
    if (isElectron() && window.electronAPI) {
      const result = await window.electronAPI.deleteTask(taskId);
      if (result.success) {
        setTasks((prev) => prev.filter((t) => t.id !== taskId));
      }
    }
  };

  // [TODO] 重试失败任务
  const handleRetryTask = async (taskId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('确定重试此任务？')) return;
    
    if (isElectron() && window.electronAPI) {
      const result = await window.electronAPI.retryTask(taskId);
      if (result.success) {
        // 任务状态将通过 onTaskUpdate 更新
      } else {
        alert(result.error || '重试失败');
      }
    }
  };

  // 刷新任务（重新总结）
  const handleRefreshTask = async (taskId: string) => {
    setRefreshingTaskId(taskId);
    try {
      if (isElectron() && window.electronAPI) {
        const result = await window.electronAPI.refreshTask(taskId);
        if (!result.success) {
          alert(result.error || '刷新任务失败');
        }
      }
    } catch (error) {
      alert(`刷新任务时出错: ${error}`);
    } finally {
      setRefreshingTaskId(null);
    }
  };

  // [TODO] 简化URL显示（提取视频ID）
  const simplifyUrl = (url: string): string => {
    const bvMatch = url.match(/BV[a-zA-Z0-9]+/);
    const b23Match = url.match(/b23\.tv\/[a-zA-Z0-9]+/);
    const ytMatch = url.match(/(?:v=|be\/)([a-zA-Z0-9_-]+)/);

    if (bvMatch) return `BV${bvMatch[0].slice(2)}`;
    if (b23Match) return b23Match[0];
    if (ytMatch) return `YT:${ytMatch[1]}`;
    return url.slice(0, 40) + (url.length > 40 ? '...' : '');
  };

  // [TODO] 格式化时间
  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    const second = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
  };

  // 过滤任务列表
  const filteredTasks = tasks.filter(task => {
    if (!searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase();
    return (
      (task.title && task.title.toLowerCase().includes(query)) ||
      (task.url && task.url.toLowerCase().includes(query)) ||
      (task.error && task.error.toLowerCase().includes(query))
    );
  });

  return (
    <div className="min-h-screen bg-black text-white font-sf">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-black/80 backdrop-blur-xl border-b border-gray-800">
        <div className="max-w-4xl mx-auto px-6 h-14 flex items-center justify-between">
          <h1 className="text-lg font-semibold tracking-tight">Video Summarizer <span className="text-xs text-gray-500 ml-2">v1.0.5</span></h1>
          <div className="flex items-center gap-2">
            <button
              onClick={handleOpenSummariesFolder}
              className="flex items-center gap-1.5 px-3 py-1.5 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg text-sm transition-colors"
              title="打开总结文件夹"
            >
              <FolderOpen className="w-4 h-4" />
            </button>
            <button
              onClick={handleOpenTranscriptionsFolder}
              className="flex items-center gap-1.5 px-3 py-1.5 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg text-sm transition-colors"
              title="打开转写文案文件夹"
            >
              <FileText className="w-4 h-4" />
            </button>
            <button
              onClick={() => setShowModal(true)}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-white text-black rounded-full text-sm font-medium hover:bg-gray-200 transition-colors"
            >
              <Plus className="w-4 h-4" />
              新建任务
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-4xl mx-auto px-6 py-8">
        {/* 搜索控件 */}
        <div className="mb-6">
          <div className="flex items-center gap-2">
            {showSearchInput ? (
              <div className="flex items-center gap-2 flex-1">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="搜索任务标题、链接或错误信息..."
                  className="flex-1 px-4 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-white focus:border-transparent"
                  autoFocus
                />
                <button
                  onClick={() => {
                    setSearchQuery('');
                    setShowSearchInput(false);
                  }}
                  className="px-3 py-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg text-sm transition-colors"
                  title="关闭搜索"
                >
                  <XCircle className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowSearchInput(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg text-sm transition-colors"
                title="搜索任务"
              >
                <Search className="w-4 h-4" />
                搜索
              </button>
            )}
          </div>
          {searchQuery && (
            <div className="mt-2 text-xs text-gray-500">
              找到 {filteredTasks.length} 个匹配任务（共 {tasks.length} 个）
            </div>
          )}
        </div>

        {tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-16 h-16 mb-6 rounded-full bg-gray-900 flex items-center justify-center">
              <FileText className="w-8 h-8 text-gray-600" />
            </div>
            <h2 className="text-xl font-semibold text-gray-300 mb-2">暂无任务</h2>
            <p className="text-gray-500 mb-6">点击右上角按钮添加新的视频总结任务</p>
            <button
              onClick={() => setShowModal(true)}
              className="flex items-center gap-2 px-5 py-2.5 bg-white text-black rounded-full text-sm font-medium hover:bg-gray-200 transition-colors"
            >
              <Plus className="w-4 h-4" />
              新建任务
            </button>
          </div>
        ) : filteredTasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-16 h-16 mb-6 rounded-full bg-gray-900 flex items-center justify-center">
              <Search className="w-8 h-8 text-gray-600" />
            </div>
            <h2 className="text-xl font-semibold text-gray-300 mb-2">未找到匹配任务</h2>
            <p className="text-gray-500 mb-6">搜索 "{searchQuery}" 没有匹配任何任务</p>
            <button
              onClick={() => setSearchQuery('')}
              className="flex items-center gap-2 px-5 py-2.5 bg-white text-black rounded-full text-sm font-medium hover:bg-gray-200 transition-colors"
            >
              清除搜索
            </button>
          </div>
        ) : (
          <div className="space-y-1">
            {filteredTasks.map((task) => (
              <div
                key={task.id}
                className="group relative flex items-center gap-4 px-5 py-4 bg-gray-950 rounded-xl hover:bg-gray-900 transition-colors"
              >
                <StatusIcon status={task.status} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="text-sm font-medium text-white">
                      {task.title || simplifyUrl(task.url)}
                    </span>
                    <button
                      className="p-1 text-gray-500 hover:text-white hover:bg-gray-800 rounded transition-colors"
                      onClick={() => handleCopyUrl(task.url)}
                      title="复制视频链接"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-500">
                    {task.status === 'completed' && task.completedAt ? (
                      <span>
                        {formatTime(task.createdAt)} → {formatTime(task.completedAt)} 已完成
                      </span>
                    ) : task.status === 'error' && task.completedAt ? (
                      <span
                        className={task.error ? "cursor-pointer hover:text-red-400 transition-colors" : ""}
                        onClick={task.error ? async () => {
                          try {
                            await navigator.clipboard.writeText(task.error || '');
                          } catch (err) {
                            console.error('复制失败:', err);
                          }
                        } : undefined}
                        title={task.error ? "点击复制错误信息" : ""}
                      >
                        {formatTime(task.createdAt)} → {formatTime(task.completedAt)} 失败
                      </span>
                    ) : task.status === 'error' ? (
                      <span
                        className={task.error ? "cursor-pointer hover:text-red-400 transition-colors" : ""}
                        onClick={task.error ? async () => {
                          try {
                            await navigator.clipboard.writeText(task.error || '');
                          } catch (err) {
                            console.error('复制失败:', err);
                          }
                        } : undefined}
                        title={task.error ? "点击复制错误信息" : ""}
                      >
                        {formatTime(task.createdAt)} 失败
                      </span>
                    ) : (
                      <>
                        <span>{formatTime(task.createdAt)}</span>
                        <span>{statusText[task.status]}</span>
                      </>
                    )}
                  </div>
                </div>

                {task.status !== 'completed' && task.status !== 'error' && task.status !== 'pending' && (
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <div className="w-40">
                      <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-white rounded-full transition-all duration-300"
                          style={{ width: `${task.progress}%` }}
                        />
                      </div>
                    </div>
                  </div>
                )}

                {task.status === 'error' && (
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={(e) => handleRetryTask(task.id, e)}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 text-white rounded-lg text-xs font-medium hover:bg-gray-700 transition-colors"
                      title="重试任务"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      重试
                    </button>
                  </div>
                )}

                <button
                  onClick={() => handleRefreshTask(task.id)}
                  className="p-1.5 text-gray-600 hover:text-blue-400 hover:bg-gray-800 rounded-lg transition-colors flex-shrink-0"
                  title="刷新任务（重新总结）"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>

                <button
                  onClick={(e) => handleDeleteTask(task.id, e)}
                  className="p-1.5 text-gray-600 hover:text-red-400 hover:bg-gray-800 rounded-lg transition-colors flex-shrink-0"
                  title="删除任务"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* 新建任务弹窗 */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowModal(false)}
          />
          <div className="relative w-full max-w-lg bg-gray-900 rounded-2xl shadow-2xl border border-gray-800 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
              <h2 className="text-lg font-semibold">新建任务</h2>
              <button
                onClick={() => setShowModal(false)}
                className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-800 transition-colors"
              >
                <XCircle className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="p-6 space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-2">
                  视频地址
                </label>
                <input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="粘贴 B站 或 YouTube 链接"
                  className="w-full px-4 py-3 bg-gray-950 border border-gray-700 rounded-xl text-white placeholder:text-gray-600 focus:outline-none focus:border-gray-500 transition-colors"
                  autoFocus
                  onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
                />
              </div>
              <button
                onClick={handleSubmit}
                disabled={!url.trim() || submitting}
                className="w-full py-3.5 bg-white text-black rounded-xl text-sm font-semibold hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {submitting ? '添加中...' : '开始分析'}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        .font-sf {
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
      `}</style>
    </div>
  );
}

export default App;
