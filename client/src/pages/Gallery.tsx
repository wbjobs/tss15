import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import '../styles/Gallery.css';

interface RenderTask {
  id: string;
  roomId: string;
  sceneName: string;
  width: number;
  height: number;
  samplesPerPixel: number;
  tileSize: number;
  overlapSize: number;
  totalTiles: number;
  totalWorkers: number;
  totalRenderTimeMs: number;
  status: string;
  lightIntensity: number;
  params: Record<string, any>;
  createdAt: string;
  completedAt: string;
  hasImage: boolean;
}

interface TaskDetail extends RenderTask {
  imageData: string | null;
  tileLogs: any[];
  workers: any[];
}

function Gallery() {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<RenderTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [usingPostgres, setUsingPostgres] = useState(false);
  const [selectedTasks, setSelectedTasks] = useState<string[]>([]);
  const [compareMode, setCompareMode] = useState(false);
  const [detailTask, setDetailTask] = useState<TaskDetail | null>(null);
  const [showDetail, setShowDetail] = useState(false);

  const fetchTasks = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const response = await fetch('http://localhost:3001/api/gallery/tasks?limit=50');
      const data = await response.json();
      if (data.success) {
        setTasks(data.tasks || []);
        setUsingPostgres(data.usingPostgres || false);
      } else {
        setError(data.error || '加载失败');
      }
    } catch (err: any) {
      setError(err.message || '网络错误');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const fetchTaskDetail = async (taskId: string) => {
    try {
      const response = await fetch(`http://localhost:3001/api/gallery/tasks/${taskId}`);
      const data = await response.json();
      if (data.success) {
        setDetailTask(data.task);
        setShowDetail(true);
      }
    } catch (err: any) {
      console.error('Failed to fetch task detail:', err);
    }
  };

  const toggleTaskSelection = (taskId: string) => {
    setSelectedTasks(prev => {
      if (prev.includes(taskId)) {
        return prev.filter(id => id !== taskId);
      }
      if (prev.length >= 4) {
        return [...prev.slice(1), taskId];
      }
      return [...prev, taskId];
    });
  };

  const handleDeleteTask = async (taskId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('确定要删除这个渲染任务吗？')) return;
    
    try {
      const response = await fetch(`http://localhost:3001/api/gallery/tasks/${taskId}`, {
        method: 'DELETE'
      });
      const data = await response.json();
      if (data.success) {
        setTasks(prev => prev.filter(t => t.id !== taskId));
        setSelectedTasks(prev => prev.filter(id => id !== taskId));
      }
    } catch (err: any) {
      console.error('Failed to delete task:', err);
    }
  };

  const formatTime = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000) return `${(ms / 60000).toFixed(1)}min`;
    return `${(ms / 3600000).toFixed(2)}h`;
  };

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleString('zh-CN');
    } catch {
      return dateStr;
    }
  };

  const getTaskImageUrl = (taskId: string) => {
    return `http://localhost:3001/api/gallery/tasks/${taskId}/image`;
  };

  const goHome = () => navigate('/');

  const selectedTaskData = tasks.filter(t => selectedTasks.includes(t.id));

  const getParamValue = (task: RenderTask, param: string) => {
    switch (param) {
      case 'samplesPerPixel': return `${task.samplesPerPixel} spp`;
      case 'tileSize': return `${task.tileSize}px`;
      case 'overlapSize': return `${task.overlapSize}px`;
      case 'resolution': return `${task.width}×${task.height}`;
      case 'totalWorkers': return `${task.totalWorkers} 个`;
      case 'totalTiles': return `${task.totalTiles} 个`;
      case 'renderTime': return formatTime(task.totalRenderTimeMs);
      case 'lightIntensity': return `${task.lightIntensity}x`;
      default: return task.params?.[param] || '-';
    }
  };

  const compareParams = [
    { key: 'samplesPerPixel', label: '采样数' },
    { key: 'resolution', label: '分辨率' },
    { key: 'tileSize', label: '瓦片大小' },
    { key: 'overlapSize', label: '重叠区域' },
    { key: 'totalWorkers', label: 'Worker 数' },
    { key: 'totalTiles', label: '瓦片总数' },
    { key: 'renderTime', label: '渲染耗时' },
    { key: 'lightIntensity', label: '光源强度' }
  ];

  return (
    <div className="gallery-page">
      <header className="gallery-header">
        <div className="header-left">
          <button className="btn-back" onClick={goHome}>← 返回</button>
          <h1 className="page-title">渲染画廊</h1>
        </div>
        <div className="header-right">
          <div className="storage-status">
            <span className={`storage-badge ${usingPostgres ? 'postgres' : 'memory'}`}>
              {usingPostgres ? '🐘 PostgreSQL' : '💾 内存存储'}
            </span>
          </div>
          <button 
            className={`btn-compare ${compareMode ? 'active' : ''}`}
            onClick={() => setCompareMode(!compareMode)}
            disabled={tasks.length < 2}
          >
            {compareMode ? `对比中 (${selectedTasks.length}/4)` : '🔍 对比模式'}
          </button>
          <button className="btn-refresh" onClick={fetchTasks} disabled={loading}>
            🔄 刷新
          </button>
        </div>
      </header>

      {error && (
        <div className="error-banner">
          ⚠️ {error}
          <button onClick={fetchTasks}>重试</button>
        </div>
      )}

      {compareMode && selectedTasks.length > 0 && (
        <div className="compare-bar">
          <span>已选择 {selectedTasks.length} 个任务进行对比</span>
          <button className="btn-clear" onClick={() => setSelectedTasks([])}>清空选择</button>
        </div>
      )}

      <div className="gallery-content">
        {loading ? (
          <div className="loading-state">
            <div className="loading-spinner"></div>
            <p>加载中...</p>
          </div>
        ) : tasks.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🖼️</div>
            <h2>暂无渲染任务</h2>
            <p>完成渲染后，任务会自动保存到画廊中</p>
            <button className="btn-primary" onClick={goHome}>开始渲染</button>
          </div>
        ) : (
          <div className="tasks-grid">
            {tasks.map(task => (
              <div 
                key={task.id} 
                className={`task-card ${selectedTasks.includes(task.id) ? 'selected' : ''} ${compareMode ? 'compare-mode' : ''}`}
                onClick={() => compareMode ? toggleTaskSelection(task.id) : fetchTaskDetail(task.id)}
              >
                <div className="task-image">
                  {task.hasImage ? (
                    <img src={getTaskImageUrl(task.id)} alt={task.sceneName} />
                  ) : (
                    <div className="no-image">
                      <span>🖼️</span>
                      <span className="no-image-text">无预览图</span>
                    </div>
                  )}
                  {compareMode && (
                    <div className="select-checkbox">
                      {selectedTasks.includes(task.id) ? '✓' : ''}
                    </div>
                  )}
                  <div className="task-badge">{task.samplesPerPixel} spp</div>
                </div>
                <div className="task-info">
                  <h3 className="task-title">{task.sceneName}</h3>
                  <div className="task-meta">
                    <span>{task.width}×{task.height}</span>
                    <span>·</span>
                    <span>{task.totalWorkers} Worker</span>
                  </div>
                  <div className="task-stats">
                    <div className="stat">
                      <span className="stat-label">瓦片</span>
                      <span className="stat-value">{task.totalTiles}</span>
                    </div>
                    <div className="stat">
                      <span className="stat-label">耗时</span>
                      <span className="stat-value">{formatTime(task.totalRenderTimeMs)}</span>
                    </div>
                  </div>
                  <div className="task-footer">
                    <span className="task-date">{formatDate(task.createdAt)}</span>
                    <button 
                      className="btn-delete" 
                      onClick={(e) => handleDeleteTask(task.id, e)}
                      title="删除"
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {compareMode && selectedTaskData.length >= 2 && (
        <div className="compare-section">
          <h2>参数对比</h2>
          <div className="compare-table-container">
            <table className="compare-table">
              <thead>
                <tr>
                  <th>参数</th>
                  {selectedTaskData.map(task => (
                    <th key={task.id} className="task-column">
                      <div className="compare-task-header">
                        <div className="compare-thumb">
                          {task.hasImage ? (
                            <img src={getTaskImageUrl(task.id)} alt="" />
                          ) : (
                            <span>🖼️</span>
                          )}
                        </div>
                        <span className="compare-task-name">{task.sceneName}</span>
                        <span className="compare-task-samples">{task.samplesPerPixel} spp</span>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {compareParams.map(param => (
                  <tr key={param.key}>
                    <td className="param-label">{param.label}</td>
                    {selectedTaskData.map(task => (
                      <td key={task.id} className="param-value">
                        {getParamValue(task, param.key)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="compare-images">
            {selectedTaskData.map(task => (
              <div key={task.id} className="compare-image-item">
                <h4>{task.sceneName}</h4>
                <div className="compare-image-wrapper">
                  {task.hasImage ? (
                    <img src={getTaskImageUrl(task.id)} alt={task.sceneName} />
                  ) : (
                    <div className="no-image-large">无预览图</div>
                  )}
                </div>
                <p className="compare-image-meta">
                  {task.samplesPerPixel} spp · {task.width}×{task.height} · {formatTime(task.totalRenderTimeMs)}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {showDetail && detailTask && (
        <div className="detail-modal" onClick={() => setShowDetail(false)}>
          <div className="detail-modal-content" onClick={e => e.stopPropagation()}>
            <button className="btn-close" onClick={() => setShowDetail(false)}>✕</button>
            
            <div className="detail-header">
              <h2>{detailTask.sceneName}</h2>
              <span className="detail-status status-completed">{detailTask.status}</span>
            </div>

            <div className="detail-body">
              <div className="detail-image-section">
                {detailTask.imageData ? (
                  <img src={`data:image/png;base64,${detailTask.imageData}`} alt={detailTask.sceneName} />
                ) : (
                  <div className="no-image-large">无预览图</div>
                )}
              </div>

              <div className="detail-info-section">
                <h3>渲染参数</h3>
                <div className="detail-info-grid">
                  <div className="info-item">
                    <span className="info-label">分辨率</span>
                    <span className="info-value">{detailTask.width} × {detailTask.height}</span>
                  </div>
                  <div className="info-item">
                    <span className="info-label">采样数</span>
                    <span className="info-value">{detailTask.samplesPerPixel} spp</span>
                  </div>
                  <div className="info-item">
                    <span className="info-label">瓦片大小</span>
                    <span className="info-value">{detailTask.tileSize}px</span>
                  </div>
                  <div className="info-item">
                    <span className="info-label">重叠区域</span>
                    <span className="info-value">{detailTask.overlapSize}px</span>
                  </div>
                  <div className="info-item">
                    <span className="info-label">瓦片总数</span>
                    <span className="info-value">{detailTask.totalTiles}</span>
                  </div>
                  <div className="info-item">
                    <span className="info-label">Worker 数</span>
                    <span className="info-value">{detailTask.totalWorkers}</span>
                  </div>
                  <div className="info-item">
                    <span className="info-label">总耗时</span>
                    <span className="info-value">{formatTime(detailTask.totalRenderTimeMs)}</span>
                  </div>
                  <div className="info-item">
                    <span className="info-label">光源强度</span>
                    <span className="info-value">{detailTask.lightIntensity}x</span>
                  </div>
                </div>

                <h3>参与 Worker</h3>
                <div className="workers-list">
                  {detailTask.workers && detailTask.workers.length > 0 ? (
                    detailTask.workers.map((worker, idx) => (
                      <div key={idx} className="worker-item">
                        <span className="worker-name">{worker.workerName || worker.workerId?.slice(0, 8)}</span>
                        <span className="worker-stat">
                          {worker.tilesRendered} 瓦片 · {formatTime(worker.avgRenderTimeMs || 0)}/瓦
                        </span>
                      </div>
                    ))
                  ) : (
                    <p className="empty-text">暂无 Worker 数据</p>
                  )}
                </div>

                <h3>瓦片日志</h3>
                <div className="tile-logs">
                  {detailTask.tileLogs && detailTask.tileLogs.length > 0 ? (
                    <div className="logs-list">
                      {detailTask.tileLogs.slice(0, 20).map((log, idx) => (
                        <div key={idx} className="log-entry">
                          <span className="log-tile">瓦片 #{log.tileIndex || log.tileId?.slice(0, 6)}</span>
                          <span className="log-worker">{log.workerName || log.workerId?.slice(0, 6)}</span>
                          <span className="log-samples">{log.samplesRendered || 0} spp</span>
                          <span className="log-time">{formatTime(log.renderTimeMs || 0)}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="empty-text">暂无瓦片日志</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Gallery;
