import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getSocket } from '../services/socket';
import {
  createPeerConnection,
  setupDataChannel,
  setupIceCandidateExchange,
  createOffer,
  handleAnswer,
  addIceCandidate,
  sendTileTask
} from '../services/webrtc';
import { useRenderStore } from '../store/renderStore';
import { generateTiles } from '../utils/tiles';
import { createDefaultScene, renderTile } from '../renderer/pathTracer';
import { loadGLTFFile } from '../utils/gltfParser';
import type { WorkerInfo, Tile, TileResult, SceneData } from '../types';
import '../styles/Scheduler.css';

function Scheduler() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const socket = getSocket();

  const {
    workers,
    status,
    tiles,
    completedTiles,
    sceneData,
    finalImageData,
    addWorker,
    removeWorker,
    updateWorker,
    setTiles,
    addCompletedTile,
    setStatus,
    setSceneData,
    getNextTile
  } = useRenderStore();

  const [tileSize, setTileSize] = useState(64);
  const [samplesPerPixel, setSamplesPerPixel] = useState(16);
  const [copied, setCopied] = useState(false);
  const [isLocalRendering, setIsLocalRendering] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const dataChannelsRef = useRef<Map<string, RTCDataChannel>>(new Map());
  const workerTileMapRef = useRef<Map<string, Tile>>(new Map());

  useEffect(() => {
    if (!roomId) return;

    const defaultScene = createDefaultScene();
    defaultScene.samplesPerPixel = samplesPerPixel;
    setSceneData(defaultScene);

    socket.on('worker-joined', (worker: WorkerInfo) => {
      console.log('Worker joined:', worker);
      addWorker({
        ...worker,
        status: 'idle',
        progress: 0,
        currentTile: null,
        tilesRendered: 0
      });

      initiateWebRTCConnection(worker.id);
    });

    socket.on('worker-left', ({ workerId }: { workerId: string }) => {
      console.log('Worker left:', workerId);
      removeWorker(workerId);
      cleanupWorkerConnection(workerId);
    });

    socket.on('offer', async ({ from, offer }: { from: string; offer: RTCSessionDescriptionInit }) => {
      console.log('Received offer from:', from);
    });

    socket.on('answer', async ({ from, answer }: { from: string; answer: RTCSessionDescriptionInit }) => {
      console.log('Received answer from:', from);
      const pc = peerConnectionsRef.current.get(from);
      if (pc) {
        await handleAnswer(pc, answer);
      }
    });

    socket.on('ice-candidate', ({ from, candidate }: { from: string; candidate: RTCIceCandidateInit }) => {
      const pc = peerConnectionsRef.current.get(from);
      if (pc) {
        addIceCandidate(pc, candidate);
      }
    });

    return () => {
      socket.off('worker-joined');
      socket.off('worker-left');
      socket.off('offer');
      socket.off('answer');
      socket.off('ice-candidate');
    };
  }, [roomId, addWorker, removeWorker, setSceneData, samplesPerPixel]);

  const initiateWebRTCConnection = useCallback(async (workerId: string) => {
    const pc = createPeerConnection();
    peerConnectionsRef.current.set(workerId, pc);

    setupIceCandidateExchange(pc, workerId);

    const dataChannel = setupDataChannel(pc, 'render-channel', {
      onOpen: () => {
        console.log('Data channel opened with worker:', workerId);
        dataChannelsRef.current.set(workerId, dataChannel);
        updateWorker(workerId, { status: 'idle' });
        
        if (status === 'rendering') {
          assignNextTile(workerId);
        }
      },
      onMessage: (message) => {
        handleWorkerMessage(workerId, message);
      },
      onClose: () => {
        console.log('Data channel closed with worker:', workerId);
        dataChannelsRef.current.delete(workerId);
        updateWorker(workerId, { status: 'disconnected' });
      }
    });

    const offer = await createOffer(pc);
    socket.emit('offer', { to: workerId, offer });
  }, [status, updateWorker]);

  const handleWorkerMessage = useCallback((workerId: string, message: any) => {
    switch (message.type) {
      case 'tile-result':
        handleTileResult(workerId, message.result);
        break;
      case 'progress':
        updateWorker(workerId, { progress: message.progress });
        break;
      case 'request-tile':
        assignNextTile(workerId);
        break;
    }
  }, [updateWorker]);

  const handleTileResult = useCallback((workerId: string, result: any) => {
    const pixelData = new Uint8ClampedArray(result.pixelData);
    const tileResult: TileResult = {
      tileId: result.tileId,
      x: result.x,
      y: result.y,
      width: result.width,
      height: result.height,
      pixelData
    };

    addCompletedTile(tileResult);
    workerTileMapRef.current.delete(workerId);

    const currentTilesRendered = workers.get(workerId)?.tilesRendered || 0;
    updateWorker(workerId, { 
      status: 'idle', 
      progress: 0, 
      currentTile: null,
      tilesRendered: currentTilesRendered + 1
    });

    socket.emit('tile-completed', { roomId, workerId, tile: { id: result.tileId } });

    if (status === 'rendering') {
      assignNextTile(workerId);
    }
  }, [addCompletedTile, updateWorker, status, roomId, workers]);

  const assignNextTile = useCallback((workerId: string) => {
    const tile = getNextTile();
    const dataChannel = dataChannelsRef.current.get(workerId);

    if (!tile || !dataChannel || dataChannel.readyState !== 'open') {
      updateWorker(workerId, { status: 'idle', currentTile: null });
      return;
    }

    workerTileMapRef.current.set(workerId, tile);
    updateWorker(workerId, { status: 'rendering', currentTile: tile, progress: 0 });

    sendTileTask(dataChannel, tile, sceneData);
    socket.emit('tile-assigned', { roomId, workerId, tile });
  }, [getNextTile, updateWorker, sceneData, roomId]);

  const cleanupWorkerConnection = useCallback((workerId: string) => {
    const pc = peerConnectionsRef.current.get(workerId);
    if (pc) {
      pc.close();
      peerConnectionsRef.current.delete(workerId);
    }
    dataChannelsRef.current.delete(workerId);
    workerTileMapRef.current.delete(workerId);
  }, []);

  const handleFileUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    if (!file.name.toLowerCase().endsWith('.gltf') && !file.name.toLowerCase().endsWith('.glb')) {
      alert('请上传 .gltf 或 .glb 格式的文件');
      return;
    }

    setIsUploading(true);
    try {
      const scene = await loadGLTFFile(file);
      scene.samplesPerPixel = samplesPerPixel;
      setSceneData(scene);
      setStatus('ready');
      
      socket.emit('scene-uploaded', { roomId, sceneData: scene });
      
      console.log('Scene uploaded successfully');
    } catch (error) {
      console.error('Failed to load GLTF file:', error);
      alert('加载 GLTF 文件失败，使用默认场景');
    } finally {
      setIsUploading(false);
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [roomId, samplesPerPixel, setSceneData, setStatus]);

  const startRender = useCallback(() => {
    if (!sceneData) return;

    const tiles = generateTiles(sceneData.width, sceneData.height, tileSize);
    setTiles(tiles);
    setStatus('rendering');

    socket.emit('start-render', { 
      roomId, 
      params: { 
        totalTiles: tiles.length,
        tileSize,
        width: sceneData.width,
        height: sceneData.height,
        samplesPerPixel: sceneData.samplesPerPixel
      } 
    });

    dataChannelsRef.current.forEach((_, workerId) => {
      assignNextTile(workerId);
    });
  }, [sceneData, tileSize, setTiles, setStatus, roomId, assignNextTile]);

  const startLocalRender = useCallback(async () => {
    if (!sceneData || !canvasRef.current) return;

    setIsLocalRendering(true);
    setStatus('rendering');

    const tiles = generateTiles(sceneData.width, sceneData.height, tileSize);
    setTiles(tiles);

    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;

    canvasRef.current.width = sceneData.width;
    canvasRef.current.height = sceneData.height;

    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      
      const pixelData = renderTile(
        sceneData,
        tile.x,
        tile.y,
        tile.width,
        tile.height,
        (progress) => {
          updateWorker('local', { progress: (i + progress) / tiles.length });
        }
      );

      const imgData = new ImageData(pixelData, tile.width, tile.height);
      ctx.putImageData(imgData, tile.x, tile.y);

      addCompletedTile({
        tileId: tile.id,
        x: tile.x,
        y: tile.y,
        width: tile.width,
        height: tile.height,
        pixelData
      });

      await new Promise(resolve => setTimeout(resolve, 0));
    }

    setStatus('completed');
    setIsLocalRendering(false);
  }, [sceneData, tileSize, setTiles, setStatus, addCompletedTile, updateWorker]);

  useEffect(() => {
    if (!canvasRef.current || !finalImageData) return;
    
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;

    if (canvasRef.current.width !== finalImageData.width) {
      canvasRef.current.width = finalImageData.width;
      canvasRef.current.height = finalImageData.height;
    }

    ctx.putImageData(finalImageData, 0, 0);
  }, [finalImageData]);

  const copyRoomCode = () => {
    if (roomId) {
      navigator.clipboard.writeText(roomId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const goHome = () => {
    navigate('/');
  };

  const workersList = Array.from(workers.values());
  const progress = tiles.length > 0 ? (completedTiles.size / tiles.length) * 100 : 0;

  return (
    <div className="scheduler-page">
      <header className="scheduler-header">
        <div className="header-left">
          <button className="btn-back" onClick={goHome}>
            ← 返回
          </button>
          <h1 className="page-title">调度控制中心</h1>
        </div>
        <div className="header-right">
          <div className="room-info">
            <span className="room-label">房间代码</span>
            <span className="room-code">{roomId}</span>
            <button className="btn-copy" onClick={copyRoomCode}>
              {copied ? '已复制!' : '复制'}
            </button>
          </div>
        </div>
      </header>

      <div className="scheduler-content">
        <div className="main-panel">
          <div className="render-canvas-container">
            <div className="canvas-header">
              <h2>渲染预览</h2>
              <div className="render-status">
                <span className={`status-badge status-${status}`}>
                  {status === 'idle' && '等待开始'}
                  {status === 'ready' && '准备就绪'}
                  {status === 'rendering' && '渲染中'}
                  {status === 'completed' && '已完成'}
                </span>
              </div>
            </div>
            
            <div className="canvas-wrapper">
              <canvas ref={canvasRef} className="render-canvas" />
              
              {tiles.length > 0 && (
                <div className="tile-overlay">
                  {tiles.map((tile) => {
                    const isCompleted = completedTiles.has(tile.id);
                    const isRendering = workersList.some(
                      w => w.currentTile?.id === tile.id
                    );
                    const scaleX = 100 / sceneData!.width;
                    const scaleY = 100 / sceneData!.height;
                    
                    return (
                      <div
                        key={tile.id}
                        className={`tile-overlay-item ${isCompleted ? 'completed' : ''} ${isRendering ? 'rendering' : ''}`}
                        style={{
                          left: `${tile.x * scaleX}%`,
                          top: `${tile.y * scaleY}%`,
                          width: `${tile.width * scaleX}%`,
                          height: `${tile.height * scaleY}%`
                        }}
                      />
                    );
                  })}
                </div>
              )}
            </div>

            <div className="progress-section">
              <div className="progress-header">
                <span>总体进度</span>
                <span>{completedTiles.size} / {tiles.length} 瓦片</span>
              </div>
              <div className="progress-bar">
                <div 
                  className="progress-fill" 
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          </div>

          <div className="control-panel">
            <h2>场景设置</h2>
            
            <div className="upload-section">
              <input
                ref={fileInputRef}
                type="file"
                accept=".gltf,.glb"
                onChange={handleFileUpload}
                style={{ display: 'none' }}
              />
              <button 
                className="btn-upload"
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading || status === 'rendering'}
              >
                <span className="upload-icon">📁</span>
                <span>{isUploading ? '上传中...' : '上传 GLTF 场景'}</span>
              </button>
              <p className="upload-hint">支持 .gltf / .glb 格式</p>
            </div>

            <h2 style={{ marginTop: '20px' }}>渲染设置</h2>
            
            <div className="setting-group">
              <label>瓦片大小</label>
              <div className="tile-size-options">
                {[32, 64, 128, 256].map(size => (
                  <button
                    key={size}
                    className={`tile-size-btn ${tileSize === size ? 'active' : ''}`}
                    onClick={() => setTileSize(size)}
                    disabled={status === 'rendering'}
                  >
                    {size}×{size}
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-group">
              <label>采样数 (每像素)</label>
              <input
                type="range"
                min="1"
                max="100"
                value={samplesPerPixel}
                onChange={(e) => {
                  const val = parseInt(e.target.value);
                  setSamplesPerPixel(val);
                  if (sceneData) {
                    const newScene = { ...sceneData, samplesPerPixel: val };
                    setSceneData(newScene);
                  }
                }}
                disabled={status === 'rendering'}
                className="slider"
              />
              <span className="slider-value">{samplesPerPixel} spp</span>
            </div>

            <div className="scene-info">
              <h3>场景信息</h3>
              {sceneData && (
                <div className="info-grid">
                  <div className="info-item">
                    <span>分辨率</span>
                    <span>{sceneData.width} × {sceneData.height}</span>
                  </div>
                  <div className="info-item">
                    <span>球体数量</span>
                    <span>{sceneData.spheres.length}</span>
                  </div>
                  <div className="info-item">
                    <span>平面数量</span>
                    <span>{sceneData.planes.length}</span>
                  </div>
                  <div className="info-item">
                    <span>总瓦片数</span>
                    <span>
                      {Math.ceil(sceneData.width / tileSize) * Math.ceil(sceneData.height / tileSize)}
                    </span>
                  </div>
                </div>
              )}
            </div>

            <div className="action-buttons">
              <button 
                className="btn btn-primary btn-large"
                onClick={startRender}
                disabled={status === 'rendering' || workersList.length === 0}
              >
                开始分布式渲染
              </button>
              <button 
                className="btn btn-secondary btn-large"
                onClick={startLocalRender}
                disabled={status === 'rendering' || isLocalRendering}
              >
                {isLocalRendering ? '本地渲染中...' : '本地预览渲染'}
              </button>
            </div>

            {workersList.length === 0 && status === 'idle' && (
              <div className="tip-message">
                💡 提示：当前没有 Worker 节点，请分享房间代码给其他浏览器以加入渲染
              </div>
            )}
          </div>
        </div>

        <div className="workers-panel">
          <div className="panel-header">
            <h2>Worker 节点</h2>
            <span className="worker-count">{workersList.length} 个节点</span>
          </div>

          <div className="workers-list">
            {workersList.length === 0 ? (
              <div className="empty-workers">
                <div className="empty-icon">⚡</div>
                <p>等待 Worker 加入...</p>
                <p className="empty-subtitle">分享房间代码以邀请更多节点</p>
              </div>
            ) : (
              workersList.map((worker) => (
                <div key={worker.id} className={`worker-card status-${worker.status}`}>
                  <div className="worker-header">
                    <div className="worker-info">
                      <div className="worker-avatar">
                        {worker.name.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <h4 className="worker-name">{worker.name}</h4>
                        <span className="worker-id">#{worker.id.slice(0, 6)}</span>
                      </div>
                    </div>
                    <span className={`worker-status status-${worker.status}`}>
                      {worker.status === 'idle' && '空闲'}
                      {worker.status === 'rendering' && '渲染中'}
                      {worker.status === 'disconnected' && '已断开'}
                    </span>
                  </div>

                  {worker.status === 'rendering' && (
                    <div className="worker-progress">
                      <div className="progress-bar-small">
                        <div 
                          className="progress-fill" 
                          style={{ width: `${(worker.progress || 0) * 100}%` }}
                        />
                      </div>
                      <span className="progress-text">
                        {Math.round((worker.progress || 0) * 100)}%
                      </span>
                    </div>
                  )}

                  <div className="worker-stats">
                    <div className="stat">
                      <span className="stat-label">已渲染</span>
                      <span className="stat-value">{worker.tilesRendered}</span>
                    </div>
                    {worker.currentTile && (
                      <div className="stat">
                        <span className="stat-label">当前瓦片</span>
                        <span className="stat-value">#{worker.currentTile.index}</span>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default Scheduler;
