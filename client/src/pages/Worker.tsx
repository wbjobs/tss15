import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getSocket } from '../services/socket';
import {
  createPeerConnection,
  setupIceCandidateExchange,
  handleOffer,
  addIceCandidate,
  sendTileResult,
  sendProgressUpdate
} from '../services/webrtc';
import { renderTile } from '../renderer/pathTracer';
import type { Tile, SceneData, TileResult } from '../types';
import '../styles/Worker.css';

type WorkerStatus = 'connecting' | 'waiting' | 'rendering' | 'disconnected';

function Worker() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const socket = getSocket();

  const [status, setStatus] = useState<WorkerStatus>('connecting');
  const [workerName, setWorkerName] = useState('');
  const [workerId, setWorkerId] = useState<string | null>(null);
  const [currentTile, setCurrentTile] = useState<Tile | null>(null);
  const [progress, setProgress] = useState(0);
  const [tilesRendered, setTilesRendered] = useState(0);
  const [error, setError] = useState('');
  const [sceneData, setSceneData] = useState<SceneData | null>(null);

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const isRenderingRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!roomId) return;

    const savedName = localStorage.getItem('workerName') || `Worker-${Math.random().toString(36).slice(2, 6)}`;
    setWorkerName(savedName);

    socket.emit('join-room', { 
      roomId,
      workerName: savedName
    }, (response: any) => {
      if (response.success) {
        setWorkerId(response.workerId);
        setStatus('waiting');
      } else {
        setError(response.error || 'Failed to join room');
        setStatus('disconnected');
      }
    });

    socket.on('offer', async ({ from, offer }: { from: string; offer: RTCSessionDescriptionInit }) => {
      console.log('Received offer from scheduler:', from);
      
      const pc = createPeerConnection();
      peerConnectionRef.current = pc;
      
      setupIceCandidateExchange(pc, from);

      pc.ondatachannel = (event) => {
        console.log('Data channel received:', event.channel.label);
        const channel = event.channel;
        dataChannelRef.current = channel;

        channel.onopen = () => {
          console.log('Data channel opened');
          setStatus('waiting');
        };

        channel.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            handleSchedulerMessage(message);
          } catch (e) {
            console.error('Failed to parse message:', e);
          }
        };

        channel.onclose = () => {
          console.log('Data channel closed');
          setStatus('disconnected');
        };

        channel.onerror = (error) => {
          console.error('Data channel error:', error);
        };
      };

      const answer = await handleOffer(pc, offer);
      socket.emit('answer', { to: from, answer });
    });

    socket.on('ice-candidate', ({ from, candidate }: { from: string; candidate: RTCIceCandidateInit }) => {
      if (peerConnectionRef.current) {
        addIceCandidate(peerConnectionRef.current, candidate);
      }
    });

    socket.on('scheduler-left', () => {
      setStatus('disconnected');
      setError('调度器已断开连接');
    });

    socket.on('scene-ready', ({ sceneData }: { sceneData: SceneData }) => {
      setSceneData(sceneData);
    });

    socket.on('render-started', ({ params }: { params: any }) => {
      console.log('Render started with params:', params);
    });

    return () => {
      socket.off('offer');
      socket.off('ice-candidate');
      socket.off('scheduler-left');
      socket.off('scene-ready');
      socket.off('render-started');
    };
  }, [roomId]);

  const handleSchedulerMessage = useCallback((message: any) => {
    switch (message.type) {
      case 'tile-task':
        handleTileTask(message.tile, message.sceneData);
        break;
    }
  }, []);

  const handleTileTask = useCallback(async (tile: Tile, scene: SceneData) => {
    if (isRenderingRef.current) {
      console.warn('Received tile task while already rendering');
      return;
    }

    isRenderingRef.current = true;
    setCurrentTile(tile);
    setStatus('rendering');
    setProgress(0);
    setSceneData(scene);

    try {
      const pixelData = renderTile(
        scene,
        tile.x,
        tile.y,
        tile.width,
        tile.height,
        (p) => {
          setProgress(p);
          if (dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
            sendProgressUpdate(dataChannelRef.current, p);
          }
        }
      );

      if (canvasRef.current) {
        const ctx = canvasRef.current.getContext('2d');
        if (ctx) {
          canvasRef.current.width = tile.width;
          canvasRef.current.height = tile.height;
          const imgData = new ImageData(pixelData, tile.width, tile.height);
          ctx.putImageData(imgData, 0, 0);
        }
      }

      const result: TileResult = {
        tileId: tile.id,
        x: tile.x,
        y: tile.y,
        width: tile.width,
        height: tile.height,
        pixelData
      };

      if (dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
        sendTileResult(dataChannelRef.current, result);
      }

      setTilesRendered(prev => prev + 1);

    } catch (error) {
      console.error('Error rendering tile:', error);
      setError('渲染出错');
    } finally {
      isRenderingRef.current = false;
      setCurrentTile(null);
      setStatus('waiting');
      setProgress(0);
    }
  }, []);

  const goHome = () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
    }
    navigate('/');
  };

  const statusText = {
    connecting: '连接中...',
    waiting: '等待任务...',
    rendering: '渲染中...',
    disconnected: '已断开'
  };

  return (
    <div className="worker-page">
      <div className="worker-bg">
        <div className="bg-grid"></div>
        <div className="bg-glow bg-glow-worker"></div>
      </div>

      <div className="worker-content">
        <header className="worker-header">
          <button className="btn-back" onClick={goHome}>
            ← 返回
          </button>
          <h1 className="worker-title">Worker 节点</h1>
          <div className="worker-room-info">
            <span className="room-label">房间:</span>
            <span className="room-code">{roomId}</span>
          </div>
        </header>

        <div className="worker-main">
          <div className="status-card">
            <div className={`status-ring status-${status}`}>
              <div className="status-ring-inner">
                {status === 'rendering' && (
                  <span className="progress-percent">{Math.round(progress * 100)}%</span>
                )}
                {status === 'waiting' && (
                  <span className="status-icon">⏸</span>
                )}
                {status === 'connecting' && (
                  <span className="status-icon">⚡</span>
                )}
                {status === 'disconnected' && (
                  <span className="status-icon">✕</span>
                )}
              </div>
            </div>
            <h2 className="status-text">{statusText[status]}</h2>
            <p className="worker-name-display">{workerName}</p>
          </div>

          <div className="worker-stats-card">
            <div className="stat-item">
              <span className="stat-label">已渲染瓦片</span>
              <span className="stat-value">{tilesRendered}</span>
            </div>
            <div className="stat-divider"></div>
            <div className="stat-item">
              <span className="stat-label">当前瓦片</span>
              <span className="stat-value">
                {currentTile ? `#${currentTile.index}` : '-'}
              </span>
            </div>
            <div className="stat-divider"></div>
            <div className="stat-item">
              <span className="stat-label">连接状态</span>
              <span className={`stat-value status-indicator status-${status}`}>
                {status === 'disconnected' ? '离线' : '在线'}
              </span>
            </div>
          </div>

          {currentTile && (
            <div className="tile-preview-card">
              <h3>当前瓦片预览</h3>
              <div className="canvas-wrapper">
                <canvas ref={canvasRef} className="tile-canvas" />
              </div>
              <div className="tile-info">
                <span>位置: ({currentTile.x}, {currentTile.y})</span>
                <span>大小: {currentTile.width}×{currentTile.height}</span>
              </div>
            </div>
          )}

          {sceneData && !currentTile && status === 'waiting' && (
            <div className="scene-info-card">
              <h3>场景信息</h3>
              <div className="info-row">
                <span>分辨率</span>
                <span>{sceneData.width} × {sceneData.height}</span>
              </div>
              <div className="info-row">
                <span>采样数</span>
                <span>{sceneData.samplesPerPixel} spp</span>
              </div>
              <div className="info-row">
                <span>球体</span>
                <span>{sceneData.spheres.length} 个</span>
              </div>
              <div className="info-row">
                <span>平面</span>
                <span>{sceneData.planes.length} 个</span>
              </div>
            </div>
          )}

          {error && (
            <div className="error-card">
              <h3>⚠️ 错误</h3>
              <p>{error}</p>
            </div>
          )}

          {status === 'waiting' && tilesRendered === 0 && (
            <div className="waiting-hint">
              <div className="hint-icon">💡</div>
              <p>您的浏览器已准备就绪，正在等待调度器分配渲染任务...</p>
              <p className="hint-sub">请确保调度器已开始渲染</p>
            </div>
          )}
        </div>

        <div className="worker-footer">
          <div className="tech-info">
            <span className="tech-badge">⚡ WebAssembly 加速</span>
            <span className="tech-badge">🔗 WebRTC P2P</span>
            <span className="tech-badge">🎯 路径追踪</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Worker;
