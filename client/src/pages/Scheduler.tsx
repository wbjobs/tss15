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
  sendTileTask,
  sendCancelTile,
  sendIncrementalTileTask,
  HeartbeatManager
} from '../services/webrtc';
import { useRenderStore } from '../store/renderStore';
import { generateTiles } from '../utils/tiles';
import { createDefaultScene, renderTile, renderTileIncremental } from '../renderer/pathTracer';
import { loadGLTFFile } from '../utils/gltfParser';
import type { WorkerInfo, Tile, TileResult, SceneData, TimeoutConfig, ReassignmentLog, IncrementalTileResult, TileProgressLog } from '../types';
import '../styles/Scheduler.css';

function Scheduler() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const socket = getSocket();

  const {
    workers, status, tiles, completedTiles, sceneData, finalImageData,
    inFlightTiles, reassignmentLogs, overlapSize, timeoutConfig,
    addWorker, removeWorker, updateWorker, updateWorkerHeartbeat,
    setTiles, addCompletedTile, setStatus, setSceneData, getNextTile,
    markTileInFlight, removeTileFromFlight, reassignTileFromWorker,
    checkWorkerTimeouts, getWorkerHealth,
    saveWorkerResumeState, loadWorkerResumeState, clearWorkerResumeState,
    handleWorkerReconnect, setTimeoutConfig, setOverlapSize,
    initAccumulationBuffer, addIncrementalTileResult, updateDisplayImage,
    startNextBatch, isBatchComplete, setTargetSamples, setBatchSize,
    currentSamples, targetSamples, batchSize, progressiveStatus,
    setProgressiveStatus, tileProgressLogs, getAverageSamples, addTileProgressLog
  } = useRenderStore();

  const [tileSize, setTileSize] = useState(64);
  const [samplesPerPixel, setSamplesPerPixel] = useState(16);
  const [copied, setCopied] = useState(false);
  const [isLocalRendering, setIsLocalRendering] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [showReassignmentLog, setShowReassignmentLog] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const dataChannelsRef = useRef<Map<string, RTCDataChannel>>(new Map());
  const workerTileMapRef = useRef<Map<string, Tile>>(new Map());
  const heartbeatManagersRef = useRef<Map<string, HeartbeatManager>>(new Map());
  const timeoutCheckRef = useRef<number | null>(null);
  const workerLatencyRef = useRef<Map<string, number>>(new Map());
  const [workerLatencies, setWorkerLatencies] = useState<Map<string, number>>(new Map());

  const currentBatchRef = useRef<{ batchId: string; startSample: number; endSample: number } | null>(null);
  const batchLoopRef = useRef<number | null>(null);
  const localCancelRef = useRef<boolean>(false);

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
        tilesRendered: 0,
        lastHeartbeat: Date.now(),
        avgRenderTime: 0,
        assignedAt: null,
        timeoutCount: 0,
        reconnectToken: (worker as any).reconnectToken || null
      });

      initiateWebRTCConnection(worker.id);
    });

    socket.on('worker-left', ({ workerId, hadActiveTile, reconnectToken }: { workerId: string; hadActiveTile: boolean; reconnectToken?: string }) => {
      console.log('Worker left:', workerId, 'hadActiveTile:', hadActiveTile);

      if (hadActiveTile) {
        const reassignedTile = reassignTileFromWorker(workerId, 'disconnected');
        if (reassignedTile) {
          console.log('Reassigned tile from disconnected worker:', reassignedTile.id);
        }
      } else {
        updateWorker(workerId, { status: 'disconnected' });
      }

      if (reconnectToken) {
        const worker = workers.get(workerId);
        if (worker && worker.currentTile) {
          saveWorkerResumeState(workerId, worker.currentTile, worker.progress, null);
        }
      }

      cleanupWorkerConnection(workerId);
    });

    socket.on('worker-reconnected', ({ oldWorkerId, newWorkerId, workerName, hadActiveTile }: any) => {
      console.log('Worker reconnected:', oldWorkerId, '->', newWorkerId);
      
      handleWorkerReconnect(oldWorkerId, newWorkerId);

      const resumeState = loadWorkerResumeState(oldWorkerId);
      if (resumeState) {
        clearWorkerResumeState(oldWorkerId);
        console.log('Found resume state for reconnected worker');
      }

      initiateWebRTCConnection(newWorkerId);
    });

    socket.on('worker-heartbeat', ({ workerId, timestamp, progress }: any) => {
      updateWorkerHeartbeat(workerId);
    });

    socket.on('answer', async ({ from, answer }: { from: string; answer: RTCSessionDescriptionInit }) => {
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
      socket.off('worker-reconnected');
      socket.off('worker-heartbeat');
      socket.off('answer');
      socket.off('ice-candidate');
    };
  }, [roomId]);

  useEffect(() => {
    if (progressiveStatus !== 'rendering') return;

    timeoutCheckRef.current = window.setInterval(() => {
      const timedOutWorkers = checkWorkerTimeouts();
      
      for (const workerId of timedOutWorkers) {
        console.warn('Worker timeout detected:', workerId);
        const reassignedTile = reassignTileFromWorker(workerId, 'timeout');
        
        const dc = dataChannelsRef.current.get(workerId);
        if (dc && reassignedTile) {
          sendCancelTile(dc, reassignedTile.id, 'timeout');
        }
        
        cleanupWorkerConnection(workerId);

        const workersList = Array.from(useRenderStore.getState().workers.values());
        const idleWorker = workersList.find(w => w.status === 'idle' && w.id !== workerId);
        if (idleWorker && reassignedTile && currentBatchRef.current) {
          assignIncrementalTile(idleWorker.id, reassignedTile);
        }
      }

      workers.forEach((worker, workerId) => {
        if (worker.status === 'rendering' && worker.assignedAt) {
          const renderTime = Date.now() - worker.assignedAt;
          if (worker.avgRenderTime > 0 && renderTime > worker.avgRenderTime * 3) {
            updateWorker(workerId, { status: 'slow' });
          }
        }
      });
    }, 5000);

    return () => {
      if (timeoutCheckRef.current) {
        clearInterval(timeoutCheckRef.current);
      }
    };
  }, [progressiveStatus]);

  const saveRenderToGallery = useCallback(async () => {
    const state = useRenderStore.getState();
    if (!state.sceneData || !state.finalImageData) return;

    try {
      const canvas = document.createElement('canvas');
      canvas.width = state.finalImageData.width;
      canvas.height = state.finalImageData.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.putImageData(state.finalImageData, 0, 0);
      
      const imageDataUrl = canvas.toDataURL('image/png');
      const base64Data = imageDataUrl.split(',')[1];

      const workersList = Array.from(state.workers.values());
      const workerData = workersList.map(w => ({
        workerId: w.id,
        workerName: w.name,
        tilesRendered: w.tilesRendered,
        avgRenderTimeMs: Math.round(w.avgRenderTime),
        totalRenderTimeMs: w.tilesRendered * Math.round(w.avgRenderTime)
      }));

      const tileLogs = state.tileProgressLogs.slice(0, 200).map(log => ({
        tileId: log.tileId,
        workerId: log.workerId,
        workerName: state.workers.get(log.workerId)?.name || '',
        batchId: log.batchId,
        sampleStart: log.sampleStart,
        sampleEnd: log.sampleEnd,
        samplesRendered: log.samplesRendered,
        renderTimeMs: log.renderTime,
        tileIndex: state.tiles.findIndex(t => t.id === log.tileId),
        tileX: state.tiles.find(t => t.id === log.tileId)?.x || 0,
        tileY: state.tiles.find(t => t.id === log.tileId)?.y || 0
      }));

      const taskData = {
        roomId: roomId,
        sceneName: state.sceneData?.name || '默认场景',
        width: state.sceneData?.width || 0,
        height: state.sceneData?.height || 0,
        samplesPerPixel: state.targetSamples,
        tileSize: tileSize,
        overlapSize: state.overlapSize,
        totalTiles: state.tiles.length,
        totalWorkers: workersList.length,
        totalRenderTimeMs: 0,
        imageData: base64Data,
        status: 'completed',
        lightIntensity: 1.0,
        params: {
          progressive: true,
          batchSize: state.batchSize,
          finalSamples: state.currentSamples
        },
        tileLogs,
        workers: workerData
      };

      const response = await fetch('http://localhost:3001/api/gallery/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(taskData)
      });

      const result = await response.json();
      if (result.success) {
        console.log('✅ Render saved to gallery:', result.taskId);
      } else {
        console.warn('Failed to save to gallery:', result.error);
      }
    } catch (error) {
      console.error('Error saving to gallery:', error);
    }
  }, [roomId, tileSize]);

  useEffect(() => {
    if (progressiveStatus === 'completed') {
      saveRenderToGallery();
    }
  }, [progressiveStatus, saveRenderToGallery]);

  useEffect(() => {
    if (progressiveStatus !== 'rendering') return;

    const checkInterval = setInterval(() => {
      const state = useRenderStore.getState();
      if (state.isBatchComplete()) {
        const newCurrentSamples = currentBatchRef.current?.endSample || state.currentSamples;
        useRenderStore.setState({ currentSamples: newCurrentSamples });
        state.updateDisplayImage();

        if (newCurrentSamples < state.targetSamples) {
          startNextBatchRender();
        } else {
          setProgressiveStatus('completed');
          setStatus('completed');
        }
      }
    }, 500);

    return () => clearInterval(checkInterval);
  }, [progressiveStatus, startNextBatchRender]);

  const initiateWebRTCConnection = useCallback(async (workerId: string) => {
    const pc = createPeerConnection();
    peerConnectionsRef.current.set(workerId, pc);
    setupIceCandidateExchange(pc, workerId);

    const dataChannel = setupDataChannel(pc, 'render-channel', {
      onOpen: () => {
        console.log('Data channel opened with worker:', workerId);
        dataChannelsRef.current.set(workerId, dataChannel);
        updateWorker(workerId, { status: 'idle', lastHeartbeat: Date.now() });

        const heartbeatManager = new HeartbeatManager();
        heartbeatManager.start(dataChannel, timeoutConfig.heartbeatInterval, {
          onTimeout: () => {
            console.warn('Heartbeat timeout for worker:', workerId);
            const reassignedTile = reassignTileFromWorker(workerId, 'timeout');
            cleanupWorkerConnection(workerId);
          },
          onHeartbeat: (latency) => {
            workerLatencyRef.current.set(workerId, latency);
            setWorkerLatencies(new Map(workerLatencyRef.current));
            updateWorkerHeartbeat(workerId);
          }
        });
        heartbeatManagersRef.current.set(workerId, heartbeatManager);
        
        if (progressiveStatus === 'rendering') {
          assignIncrementalTile(workerId);
        }
      },
      onMessage: (message) => {
        handleWorkerMessage(workerId, message);
      },
      onClose: () => {
        console.log('Data channel closed with worker:', workerId);
        dataChannelsRef.current.delete(workerId);
        const hbManager = heartbeatManagersRef.current.get(workerId);
        if (hbManager) {
          hbManager.stop();
          heartbeatManagersRef.current.delete(workerId);
        }
        updateWorker(workerId, { status: 'disconnected' });
      }
    });

    const offer = await createOffer(pc);
    socket.emit('offer', { to: workerId, offer });
  }, [progressiveStatus, timeoutConfig]);

  const handleWorkerMessage = useCallback((workerId: string, message: any) => {
    switch (message.type) {
      case 'tile-result':
        handleTileResult(workerId, message.result);
        break;
      case 'incremental-tile-result':
        handleIncrementalTileResult(workerId, message.result);
        break;
      case 'progress':
        updateWorker(workerId, { progress: message.progress });
        socket.emit('worker-progress', { roomId, workerId, progress: message.progress });
        break;
      case 'request-tile':
        if (progressiveStatus === 'rendering') {
          assignIncrementalTile(workerId);
        }
        break;
      case 'heartbeat-ack':
        const hbManager = heartbeatManagersRef.current.get(workerId);
        if (hbManager) {
          hbManager.handleHeartbeatAck();
        }
        break;
    }
  }, [roomId, progressiveStatus]);

  const handleIncrementalTileResult = useCallback((workerId: string, result: any) => {
    if (!currentBatchRef.current || result.batchId !== currentBatchRef.current.batchId) {
      console.warn('Received result for old batch, ignoring');
      return;
    }

    const accumulatedColor = new Float32Array(result.accumulatedColor);
    const renderStartTime = useRenderStore.getState().inFlightTiles.get(result.tileId)?.assignedAt;
    const renderTime = renderStartTime ? Date.now() - renderStartTime : 0;

    const tileResult: IncrementalTileResult & { overlap: any; coreWidth: number; coreHeight: number } = {
      tileId: result.tileId,
      x: result.x,
      y: result.y,
      width: result.width,
      height: result.height,
      overlap: result.overlap || { top: 0, bottom: 0, left: 0, right: 0 },
      accumulatedColor,
      sampleCount: result.sampleCount,
      batchId: result.batchId,
      renderTime,
      coreWidth: result.coreWidth,
      coreHeight: result.coreHeight
    };

    addIncrementalTileResult(tileResult);

    const progressLog: TileProgressLog = {
      tileId: result.tileId,
      workerId,
      batchId: result.batchId,
      sampleStart: currentBatchRef.current.startSample,
      sampleEnd: currentBatchRef.current.endSample,
      samplesRendered: result.sampleCount,
      renderTime,
      timestamp: Date.now()
    };
    addTileProgressLog(progressLog);

    workerTileMapRef.current.delete(workerId);

    const worker = useRenderStore.getState().workers.get(workerId);
    const currentTilesRendered = worker?.tilesRendered || 0;
    const oldAvgRenderTime = worker?.avgRenderTime || 0;
    const newAvgRenderTime = renderTime > 0
      ? (oldAvgRenderTime === 0 ? renderTime : oldAvgRenderTime * 0.7 + renderTime * 0.3)
      : oldAvgRenderTime;

    updateWorker(workerId, { 
      status: 'idle', 
      progress: 0, 
      currentTile: null,
      tilesRendered: currentTilesRendered + 1,
      avgRenderTime: newAvgRenderTime,
      assignedAt: null
    });

    socket.emit('tile-completed', { roomId, workerId, tile: { id: result.tileId }, renderTime });

    if (useRenderStore.getState().progressiveStatus === 'rendering') {
      assignIncrementalTile(workerId);
    }
  }, [addIncrementalTileResult, updateWorker, roomId, addTileProgressLog]);

  const handleTileResult = useCallback((workerId: string, result: any) => {
    const pixelData = new Uint8ClampedArray(result.pixelData);
    const renderStartTime = useRenderStore.getState().inFlightTiles.get(result.tileId)?.assignedAt;
    const renderTime = renderStartTime ? Date.now() - renderStartTime : 0;

    const tileResult: TileResult = {
      tileId: result.tileId,
      x: result.x,
      y: result.y,
      width: result.width,
      height: result.height,
      overlap: result.overlap || { top: 0, bottom: 0, left: 0, right: 0 },
      pixelData,
      renderTime
    };

    (tileResult as any).coreWidth = result.coreWidth;
    (tileResult as any).coreHeight = result.coreHeight;

    addCompletedTile(tileResult);
    removeTileFromFlight(result.tileId);
    workerTileMapRef.current.delete(workerId);

    const worker = useRenderStore.getState().workers.get(workerId);
    const currentTilesRendered = worker?.tilesRendered || 0;
    const oldAvgRenderTime = worker?.avgRenderTime || 0;
    const newAvgRenderTime = renderTime > 0
      ? (oldAvgRenderTime === 0 ? renderTime : oldAvgRenderTime * 0.7 + renderTime * 0.3)
      : oldAvgRenderTime;

    updateWorker(workerId, { 
      status: 'idle', 
      progress: 0, 
      currentTile: null,
      tilesRendered: currentTilesRendered + 1,
      avgRenderTime: newAvgRenderTime,
      assignedAt: null
    });

    socket.emit('tile-completed', { roomId, workerId, tile: { id: result.tileId }, renderTime });

    if (useRenderStore.getState().status === 'rendering') {
      assignNextTile(workerId);
    }
  }, [addCompletedTile, removeTileFromFlight, updateWorker, roomId]);

  const assignIncrementalTile = useCallback((workerId: string, specificTile?: Tile) => {
    const tile = specificTile || getNextTile();
    const dataChannel = dataChannelsRef.current.get(workerId);
    const batch = currentBatchRef.current;

    if (!tile || !dataChannel || dataChannel.readyState !== 'open' || !batch) {
      updateWorker(workerId, { status: 'idle', currentTile: null, assignedAt: null });
      return;
    }

    workerTileMapRef.current.set(workerId, tile);
    markTileInFlight(tile.id, workerId, batch.batchId, batch.startSample, batch.endSample);
    updateWorker(workerId, { 
      status: 'rendering', 
      currentTile: tile, 
      progress: 0,
      assignedAt: Date.now()
    });

    sendIncrementalTileTask(dataChannel, {
      tile,
      sceneData: sceneData!,
      startSample: batch.startSample,
      endSample: batch.endSample,
      batchId: batch.batchId
    });
    socket.emit('tile-assigned', { roomId, workerId, tile });
  }, [getNextTile, updateWorker, markTileInFlight, sceneData, roomId]);

  const assignNextTile = useCallback((workerId: string) => {
    const tile = getNextTile();
    const dataChannel = dataChannelsRef.current.get(workerId);

    if (!tile || !dataChannel || dataChannel.readyState !== 'open') {
      updateWorker(workerId, { status: 'idle', currentTile: null, assignedAt: null });
      return;
    }

    workerTileMapRef.current.set(workerId, tile);
    markTileInFlight(tile.id, workerId, '', 0, 0);
    updateWorker(workerId, { 
      status: 'rendering', 
      currentTile: tile, 
      progress: 0,
      assignedAt: Date.now()
    });

    sendTileTask(dataChannel, tile, sceneData);
    socket.emit('tile-assigned', { roomId, workerId, tile });
  }, [getNextTile, updateWorker, markTileInFlight, sceneData, roomId]);

  const assignSpecificTile = useCallback((workerId: string, tile: Tile) => {
    const dataChannel = dataChannelsRef.current.get(workerId);
    if (!dataChannel || dataChannel.readyState !== 'open') return;

    markTileInFlight(tile.id, workerId, '', 0, 0);
    updateWorker(workerId, { 
      status: 'rendering', 
      currentTile: tile, 
      progress: 0,
      assignedAt: Date.now()
    });

    sendTileTask(dataChannel, tile, sceneData);
    socket.emit('tile-assigned', { roomId, workerId, tile });
    socket.emit('tile-reassigned', { 
      roomId, tileId: tile.id, 
      fromWorkerId: '', toWorkerId: workerId, 
      reason: 'reassignment' 
    });
  }, [markTileInFlight, updateWorker, sceneData, roomId]);

  const cleanupWorkerConnection = useCallback((workerId: string) => {
    const pc = peerConnectionsRef.current.get(workerId);
    if (pc) {
      pc.close();
      peerConnectionsRef.current.delete(workerId);
    }
    dataChannelsRef.current.delete(workerId);
    workerTileMapRef.current.delete(workerId);
    const hbManager = heartbeatManagersRef.current.get(workerId);
    if (hbManager) {
      hbManager.stop();
      heartbeatManagersRef.current.delete(workerId);
    }
  }, []);

  const startNextBatchRender = useCallback(() => {
    const batchInfo = startNextBatch();
    if (!batchInfo) return false;
    currentBatchRef.current = batchInfo;

    dataChannelsRef.current.forEach((_, workerId) => {
      assignIncrementalTile(workerId);
    });

    return true;
  }, [startNextBatch, assignIncrementalTile]);

  const cancelAllWorkers = useCallback(() => {
    dataChannelsRef.current.forEach((dc, workerId) => {
      const inFlight = inFlightTiles.get(workerId);
      if (inFlight) {
        sendCancelTile(dc, inFlight.tile.id, 'user-cancel');
      }
    });
  }, [inFlightTiles]);

  const handleTargetSamplesChange = useCallback((newSamples: number) => {
    setTargetSamples(newSamples);
    
    if (progressiveStatus === 'rendering' || progressiveStatus === 'paused') {
      if (newSamples > currentSamples) {
        if (progressiveStatus !== 'rendering') {
          setProgressiveStatus('rendering');
          setStatus('rendering');
          startNextBatchRender();
        }
      }
    }
  }, [progressiveStatus, currentSamples, setTargetSamples, setProgressiveStatus, setStatus, startNextBatchRender]);

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
    } catch (error) {
      console.error('Failed to load GLTF file:', error);
      alert('加载 GLTF 文件失败，使用默认场景');
    } finally {
      setIsUploading(false);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [roomId, samplesPerPixel, setSceneData, setStatus]);

  const startProgressiveRender = useCallback(() => {
    if (!sceneData) return;
    const genTiles = generateTiles(sceneData.width, sceneData.height, tileSize, overlapSize);
    setTiles(genTiles);
    initAccumulationBuffer(sceneData.width, sceneData.height);
    
    setProgressiveStatus('rendering');
    setStatus('rendering');
    
    socket.emit('start-render', { 
      roomId, 
      params: { 
        totalTiles: genTiles.length, 
        tileSize, 
        width: sceneData.width, 
        height: sceneData.height, 
        samplesPerPixel: targetSamples, 
        overlapSize,
        progressive: true,
        batchSize
      }
    });

    startNextBatchRender();
  }, [sceneData, tileSize, overlapSize, setTiles, initAccumulationBuffer, setProgressiveStatus, setStatus, roomId, targetSamples, batchSize, startNextBatchRender]);

  const startRender = useCallback(() => {
    if (!sceneData) return;
    const genTiles = generateTiles(sceneData.width, sceneData.height, tileSize, overlapSize);
    setTiles(genTiles);
    setStatus('rendering');
    socket.emit('start-render', { 
      roomId, 
      params: { totalTiles: genTiles.length, tileSize, width: sceneData.width, height: sceneData.height, samplesPerPixel: sceneData.samplesPerPixel, overlapSize }
    });
    dataChannelsRef.current.forEach((_, workerId) => {
      assignNextTile(workerId);
    });
  }, [sceneData, tileSize, overlapSize, setTiles, setStatus, roomId, assignNextTile]);

  const startLocalRender = useCallback(async () => {
    if (!sceneData || !canvasRef.current) return;
    setIsLocalRendering(true);
    setStatus('rendering');
    setProgressiveStatus('rendering');

    const genTiles = generateTiles(sceneData.width, sceneData.height, tileSize, overlapSize);
    setTiles(genTiles);
    initAccumulationBuffer(sceneData.width, sceneData.height);

    localCancelRef.current = false;
    let currentSample = 0;

    while (currentSample < targetSamples && !localCancelRef.current) {
      const batchEnd = Math.min(currentSample + batchSize, targetSamples);

      for (let i = 0; i < genTiles.length; i++) {
        if (localCancelRef.current) break;
        const tile = genTiles[i];
        
        const result = renderTileIncremental(
          sceneData, tile.x, tile.y, tile.width, tile.height,
          tile.index, tile.overlap, currentSample, batchEnd,
          (progress) => { 
            updateWorker('local', { progress: (i + progress) / genTiles.length }); 
          },
          () => localCancelRef.current
        );

        if (!result.cancelled) {
          addIncrementalTileResult({
            tileId: tile.id,
            x: tile.x, y: tile.y,
            width: tile.width, height: tile.height,
            overlap: tile.overlap,
            accumulatedColor: result.accumulatedColor,
            sampleCount: batchEnd - currentSample,
            batchId: `local-${currentSample}`,
            renderTime: 0,
            coreWidth: result.coreWidth,
            coreHeight: result.coreHeight
          });
        }

        await new Promise(resolve => setTimeout(resolve, 0));
      }

      currentSample = batchEnd;
      useRenderStore.setState({ currentSamples: currentSample });
      updateDisplayImage();
    }

    setStatus(currentSample >= targetSamples ? 'completed' : 'paused');
    setProgressiveStatus(currentSample >= targetSamples ? 'completed' : 'paused');
    setIsLocalRendering(false);
  }, [sceneData, tileSize, overlapSize, setTiles, initAccumulationBuffer, addIncrementalTileResult, updateDisplayImage, targetSamples, batchSize, updateWorker]);

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
    if (roomId) { navigator.clipboard.writeText(roomId); setCopied(true); setTimeout(() => setCopied(false), 2000); }
  };
  const goHome = () => navigate('/');
  const goGallery = () => navigate('/gallery');

  const workersList = Array.from(workers.values());
  const progress = tiles.length > 0 ? (batchCompletedTiles() / tiles.length) * 100 : 0;
  const avgSamples = getAverageSamples();

  function batchCompletedTiles() {
    const state = useRenderStore.getState();
    return state.batchCompletedTiles.size;
  }

  const getHealthIndicator = (workerId: string) => {
    const health = getWorkerHealth(workerId);
    const latency = workerLatencies.get(workerId);
    return { health, latency };
  };

  return (
    <div className="scheduler-page">
      <header className="scheduler-header">
        <div className="header-left">
          <button className="btn-back" onClick={goHome}>← 返回</button>
          <h1 className="page-title">调度控制中心</h1>
        </div>
        <div className="header-right">
          <button className="btn-log" onClick={goGallery}>
            🖼 画廊
          </button>
          <button className="btn-log" onClick={() => setShowReassignmentLog(!showReassignmentLog)}>
            📋 日志 ({reassignmentLogs.length})
          </button>
          <div className="room-info">
            <span className="room-label">房间代码</span>
            <span className="room-code">{roomId}</span>
            <button className="btn-copy" onClick={copyRoomCode}>{copied ? '已复制!' : '复制'}</button>
          </div>
        </div>
      </header>

      <div className="scheduler-content">
        <div className="main-panel">
          <div className="render-canvas-container">
            <div className="canvas-header">
              <h2>渲染预览</h2>
              <div className="render-status">
                <span className={`status-badge status-${progressiveStatus}`}>
                  {progressiveStatus === 'idle' && '等待开始'}
                  {progressiveStatus === 'rendering' && '渐进渲染中'}
                  {progressiveStatus === 'paused' && '已暂停'}
                  {progressiveStatus === 'completed' && '已完成'}
                </span>
              </div>
            </div>
            
            <div className="canvas-wrapper">
              <canvas ref={canvasRef} className="render-canvas" />
              {tiles.length > 0 && (
                <div className="tile-overlay">
                  {tiles.map((tile) => {
                    const state = useRenderStore.getState();
                    const isCompleted = state.batchCompletedTiles.has(tile.id);
                    const isRendering = workersList.some(w => w.currentTile?.id === tile.id);
                    const isInFlight = state.inFlightTiles.has(tile.id);
                    const scaleX = 100 / sceneData!.width;
                    const scaleY = 100 / sceneData!.height;
                    return (
                      <div key={tile.id}
                        className={`tile-overlay-item ${isCompleted ? 'completed' : ''} ${isRendering ? 'rendering' : ''} ${isInFlight && !isCompleted ? 'in-flight' : ''}`}
                        style={{ left: `${tile.x * scaleX}%`, top: `${tile.y * scaleY}%`, width: `${tile.width * scaleX}%`, height: `${tile.height * scaleY}%` }}
                      />
                    );
                  })}
                </div>
              )}
            </div>

            <div className="progress-section">
              <div className="progress-header">
                <span>采样进度</span>
                <span>{Math.round(avgSamples)} / {targetSamples} spp</span>
              </div>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${Math.min(100, (avgSamples / targetSamples) * 100)}%` }} />
              </div>
              <div className="progress-header" style={{ marginTop: '8px' }}>
                <span>当前批次</span>
                <span>{batchCompletedTiles()} / {tiles.length} 瓦片</span>
              </div>
            </div>
          </div>

          <div className="control-panel">
            <h2>场景设置</h2>
            <div className="upload-section">
              <input ref={fileInputRef} type="file" accept=".gltf,.glb" onChange={handleFileUpload} style={{ display: 'none' }} />
              <button className="btn-upload" onClick={() => fileInputRef.current?.click()} disabled={isUploading || progressiveStatus === 'rendering'}>
                <span className="upload-icon">📁</span>
                <span>{isUploading ? '上传中...' : '上传 GLTF 场景'}</span>
              </button>
              <p className="upload-hint">支持 .gltf / .glb 格式</p>
            </div>

            <h2 style={{ marginTop: '20px' }}>渐进式渲染设置</h2>
            
            <div className="setting-group">
              <label>目标采样数 (SPP)</label>
              <input type="range" min="1" max="1000" step="1" value={targetSamples}
                onChange={(e) => { 
                  const val = parseInt(e.target.value); 
                  handleTargetSamplesChange(val);
                }}
                className="slider" />
              <span className="slider-value">{targetSamples} spp</span>
            </div>

            <div className="setting-group">
              <label>每批样本数</label>
              <div className="tile-size-options">
                {[1, 5, 10, 25, 50].map(size => (
                  <button key={size} className={`tile-size-btn ${batchSize === size ? 'active' : ''}`} 
                    onClick={() => setBatchSize(size)} 
                    disabled={progressiveStatus === 'rendering'}>
                    {size}
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-group">
              <label>瓦片大小</label>
              <div className="tile-size-options">
                {[32, 64, 128, 256].map(size => (
                  <button key={size} className={`tile-size-btn ${tileSize === size ? 'active' : ''}`} onClick={() => setTileSize(size)} disabled={progressiveStatus === 'rendering'}>
                    {size}×{size}
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-group">
              <label>重叠区域 (接缝融合)</label>
              <input type="range" min="0" max="16" value={overlapSize}
                onChange={(e) => setOverlapSize(parseInt(e.target.value))}
                disabled={progressiveStatus === 'rendering'} className="slider" />
              <span className="slider-value">{overlapSize}px</span>
            </div>

            <div className="setting-group">
              <label>超时阈值 (ms)</label>
              <input type="range" min="5000" max="60000" step="5000" value={timeoutConfig.kickThreshold}
                onChange={(e) => setTimeoutConfig({ ...timeoutConfig, kickThreshold: parseInt(e.target.value), warningThreshold: parseInt(e.target.value) / 2 })}
                disabled={progressiveStatus === 'rendering'} className="slider" />
              <span className="slider-value">{(timeoutConfig.kickThreshold / 1000).toFixed(0)}s</span>
            </div>

            <div className="scene-info">
              <h3>场景信息</h3>
              {sceneData && (
                <div className="info-grid">
                  <div className="info-item"><span>分辨率</span><span>{sceneData.width} × {sceneData.height}</span></div>
                  <div className="info-item"><span>球体</span><span>{sceneData.spheres.length}</span></div>
                  <div className="info-item"><span>平面</span><span>{sceneData.planes.length}</span></div>
                  <div className="info-item"><span>总瓦片</span><span>{Math.ceil(sceneData.width / tileSize) * Math.ceil(sceneData.height / tileSize)}</span></div>
                  <div className="info-item"><span>当前采样</span><span>{Math.round(avgSamples)} spp</span></div>
                </div>
              )}
            </div>

            <div className="action-buttons">
              <button className="btn btn-primary btn-large" onClick={startProgressiveRender} 
                disabled={progressiveStatus === 'rendering' || workersList.length === 0}>
                开始渐进式渲染
              </button>
              <button className="btn btn-secondary btn-large" onClick={startLocalRender} 
                disabled={progressiveStatus === 'rendering' || isLocalRendering}>
                {isLocalRendering ? '本地渲染中...' : '本地预览渲染'}
              </button>
              {progressiveStatus === 'rendering' && (
                <button className="btn btn-danger btn-large" onClick={() => {
                  cancelAllWorkers();
                  setProgressiveStatus('paused');
                  setStatus('paused');
                  localCancelRef.current = true;
                }}>
                  暂停渲染
                </button>
              )}
              {progressiveStatus === 'paused' && (
                <button className="btn btn-primary btn-large" onClick={() => {
                  if (currentSamples < targetSamples) {
                    setProgressiveStatus('rendering');
                    setStatus('rendering');
                    startNextBatchRender();
                  }
                }}>
                  继续渲染
                </button>
              )}
            </div>

            {workersList.length === 0 && progressiveStatus === 'idle' && (
              <div className="tip-message">💡 提示：当前没有 Worker 节点，请分享房间代码给其他浏览器以加入渲染</div>
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
              workersList.map((worker) => {
                const { health, latency } = getHealthIndicator(worker.id);
                return (
                  <div key={worker.id} className={`worker-card status-${worker.status} health-${health}`}>
                    <div className="worker-header">
                      <div className="worker-info">
                        <div className="worker-avatar">{worker.name.charAt(0).toUpperCase()}</div>
                        <div>
                          <h4 className="worker-name">{worker.name}</h4>
                          <span className="worker-id">#{worker.id.slice(0, 6)}</span>
                          {latency !== undefined && (
                            <span className={`worker-latency latency-${latency < 100 ? 'good' : latency < 500 ? 'moderate' : 'high'}`}>
                              {latency}ms
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="worker-status-group">
                        <span className={`health-indicator health-${health}`} title={`Health: ${health}`} />
                        <span className={`worker-status status-${worker.status}`}>
                          {worker.status === 'idle' && '空闲'}
                          {worker.status === 'rendering' && '渲染中'}
                          {worker.status === 'disconnected' && '已断开'}
                          {worker.status === 'slow' && '⚠ 慢速'}
                          {worker.status === 'timeout' && '⏱ 超时'}
                        </span>
                      </div>
                    </div>

                    {worker.status === 'rendering' && (
                      <div className="worker-progress">
                        <div className="progress-bar-small">
                          <div className="progress-fill" style={{ width: `${(worker.progress || 0) * 100}%` }} />
                        </div>
                        <span className="progress-text">{Math.round((worker.progress || 0) * 100)}%</span>
                      </div>
                    )}

                    <div className="worker-stats">
                      <div className="stat">
                        <span className="stat-label">已渲染</span>
                        <span className="stat-value">{worker.tilesRendered}</span>
                      </div>
                      {worker.currentTile && (
                        <div className="stat">
                          <span className="stat-label">瓦片</span>
                          <span className="stat-value">#{worker.currentTile.index}</span>
                        </div>
                      )}
                      {worker.avgRenderTime > 0 && (
                        <div className="stat">
                          <span className="stat-label">平均耗时</span>
                          <span className="stat-value">{(worker.avgRenderTime / 1000).toFixed(1)}s</span>
                        </div>
                      )}
                      {worker.timeoutCount > 0 && (
                        <div className="stat stat-warning">
                          <span className="stat-label">超时次数</span>
                          <span className="stat-value">{worker.timeoutCount}</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {showReassignmentLog && reassignmentLogs.length > 0 && (
            <div className="reassignment-log">
              <h3>重分配日志</h3>
              {reassignmentLogs.slice(-10).reverse().map((log, i) => (
                <div key={i} className="log-entry">
                  <span className={`log-reason reason-${log.reason}`}>{log.reason}</span>
                  <span className="log-tile">瓦片 {log.tileId}</span>
                  <span className="log-from">{log.fromWorkerName}</span>
                  <span className="log-time">{new Date(log.timestamp).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default Scheduler;
