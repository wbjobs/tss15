import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getSocket } from '../services/socket';
import {
  createPeerConnection,
  setupIceCandidateExchange,
  handleOffer,
  addIceCandidate,
  sendTileResult,
  sendIncrementalTileResult,
  sendProgressUpdate,
  sendHeartbeatAck
} from '../services/webrtc';
import { renderTile, renderTileIncremental } from '../renderer/pathTracer';
import type { Tile, SceneData, TileResult, TileOverlap, WorkerResumeState, IncrementalTileTask } from '../types';
import '../styles/Worker.css';

type WorkerStatus = 'connecting' | 'waiting' | 'rendering' | 'disconnected' | 'reconnecting' | 'cancelling';

const RECONNECT_TOKEN_KEY = 'workerReconnectToken';
const RESUME_STATE_KEY = 'workerResumeState';

function Worker() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const socket = getSocket();

  const [status, setStatus] = useState<WorkerStatus>('connecting');
  const [workerName, setWorkerName] = useState('');
  const [workerId, setWorkerId] = useState<string | null>(null);
  const [reconnectToken, setReconnectToken] = useState<string | null>(null);
  const [currentTile, setCurrentTile] = useState<Tile | null>(null);
  const [progress, setProgress] = useState(0);
  const [tilesRendered, setTilesRendered] = useState(0);
  const [error, setError] = useState('');
  const [sceneData, setSceneData] = useState<SceneData | null>(null);
  const [latency, setLatency] = useState<number>(-1);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [cancelReason, setCancelReason] = useState('');
  const [currentBatchId, setCurrentBatchId] = useState<string | null>(null);
  const [sampleRange, setSampleRange] = useState<{ start: number; end: number } | null>(null);

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const isRenderingRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cancelRequestedRef = useRef(false);
  const currentTileIdRef = useRef<string | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const sceneDataRef = useRef<SceneData | null>(null);

  useEffect(() => {
    sceneDataRef.current = sceneData;
  }, [sceneData]);

  const saveResumeState = useCallback((tile: Tile, tileProgress: number, partialData: Uint8ClampedArray | null) => {
    if (!reconnectToken) return;
    const resumeState: WorkerResumeState = {
      workerId: workerId || '',
      workerName,
      reconnectToken,
      currentTile: tile,
      tileProgress,
      partialPixelData: partialData ? Array.from(partialData) as unknown as Uint8ClampedArray : null
    };
    try {
      localStorage.setItem(RESUME_STATE_KEY, JSON.stringify({
        ...resumeState,
        partialPixelData: partialData ? Array.from(partialData) : null
      }));
    } catch (e) {
      console.warn('Failed to save resume state:', e);
    }
  }, [workerId, workerName, reconnectToken]);

  const clearResumeState = useCallback(() => {
    try {
      localStorage.removeItem(RESUME_STATE_KEY);
    } catch (e) {
      console.warn('Failed to clear resume state:', e);
    }
  }, []);

  const loadResumeState = useCallback((): WorkerResumeState | null => {
    try {
      const raw = localStorage.getItem(RESUME_STATE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          ...parsed,
          partialPixelData: parsed.partialPixelData ? new Uint8ClampedArray(parsed.partialPixelData) : null
        };
      }
    } catch (e) {
      console.warn('Failed to load resume state:', e);
    }
    return null;
  }, []);

  const attemptReconnect = useCallback(() => {
    if (!roomId) return;
    setStatus('reconnecting');
    setReconnectAttempts(prev => prev + 1);

    const backoff = Math.min(1000 * Math.pow(2, reconnectAttempts), 10000);

    reconnectTimerRef.current = window.setTimeout(() => {
      console.log(`Attempting reconnection (attempt ${reconnectAttempts + 1})...`);
      joinRoom();
    }, backoff);
  }, [roomId, reconnectAttempts]);

  const joinRoom = useCallback(() => {
    if (!roomId) return;

    setError('');
    const savedName = localStorage.getItem('workerName') || `Worker-${Math.random().toString(36).slice(2, 6)}`;
    setWorkerName(savedName);
    localStorage.setItem('workerName', savedName);

    let savedToken = reconnectToken || localStorage.getItem(RECONNECT_TOKEN_KEY);
    if (!savedToken) {
      savedToken = null;
    }

    const payload: any = {
      roomId,
      workerName: savedName
    };

    if (savedToken) {
      payload.reconnectToken = savedToken;
    }

    socket.emit('join-room', payload, (response: any) => {
      if (response.success) {
        setWorkerId(response.workerId);
        if (response.reconnectToken) {
          setReconnectToken(response.reconnectToken);
          localStorage.setItem(RECONNECT_TOKEN_KEY, response.reconnectToken);
        }
        setStatus('waiting');
        setReconnectAttempts(0);
        console.log('Joined room successfully:', response.workerId);
      } else {
        setError(response.error || '加入房间失败');
        setStatus('disconnected');
      }
    });
  }, [roomId, reconnectToken]);

  useEffect(() => {
    if (!roomId) return;

    joinRoom();

    socket.on('offer', async ({ from, offer }: { from: string; offer: RTCSessionDescriptionInit }) => {
      console.log('Received offer from scheduler:', from);

      if (peerConnectionRef.current) {
        try {
          peerConnectionRef.current.close();
        } catch (e) {
          console.warn('Failed to close old peer connection:', e);
        }
      }

      const pc = createPeerConnection();
      peerConnectionRef.current = pc;

      setupIceCandidateExchange(pc, from);

      pc.ondatachannel = (event) => {
        console.log('Data channel received:', event.channel.label);
        const channel = event.channel;
        dataChannelRef.current = channel;

        channel.onopen = () => {
          console.log('Data channel opened');
          if (status === 'reconnecting') {
            setStatus('waiting');
          } else if (status !== 'rendering') {
            setStatus('waiting');
          }
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
          if (isRenderingRef.current && currentTileIdRef.current) {
            setStatus('disconnected');
            attemptReconnect();
          } else {
            setStatus('disconnected');
          }
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
      cancelRequestedRef.current = true;
    });

    socket.on('disconnect', () => {
      console.log('Socket disconnected');
      if (isRenderingRef.current) {
        attemptReconnect();
      } else {
        setStatus('disconnected');
      }
    });

    socket.on('connect', () => {
      console.log('Socket reconnected');
      if (status === 'disconnected' || status === 'reconnecting') {
        joinRoom();
      }
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
      socket.off('disconnect');
      socket.off('connect');
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
    };
  }, [roomId]);

  const renderTileWithCancel = useCallback(async (
    tile: Tile,
    scene: SceneData,
    startProgress: number = 0
  ): Promise<{ pixelData: Uint8ClampedArray; coreWidth: number; coreHeight: number; cancelled: boolean }> => {
    const { width, height, samplesPerPixel, camera } = scene;
    const overlap: TileOverlap = tile.overlap || { top: 0, bottom: 0, left: 0, right: 0 };

    const renderX = tile.x - overlap.left;
    const renderY = tile.y - overlap.top;
    const renderWidth = tile.width + overlap.left + overlap.right;
    const renderHeight = tile.height + overlap.top + overlap.bottom;

    const clampedRenderX = Math.max(0, renderX);
    const clampedRenderY = Math.max(0, renderY);
    const clampedRenderRight = Math.min(width, renderX + renderWidth);
    const clampedRenderBottom = Math.min(height, renderY + renderHeight);
    const actualRenderWidth = clampedRenderRight - clampedRenderX;
    const actualRenderHeight = clampedRenderBottom - clampedRenderY;

    const pixelData = new Uint8ClampedArray(actualRenderWidth * actualRenderHeight * 4);

    const aspectRatio = width / height;
    const fovRad = (camera.fov * Math.PI) / 180;
    const viewportHeight = 2 * Math.tan(fovRad / 2);
    const viewportWidth = viewportHeight * aspectRatio;

    const camPos = camera.position;
    const camTarget = camera.target;
    const camDir = [
      (camTarget[0] - camPos[0]),
      (camTarget[1] - camPos[1]),
      (camTarget[2] - camPos[2])
    ];
    const camDirLen = Math.sqrt(camDir[0] ** 2 + camDir[1] ** 2 + camDir[2] ** 2);
    const camDirNorm = [camDir[0] / camDirLen, camDir[1] / camDirLen, camDir[2] / camDirLen];

    const worldUp: [number, number, number] = [0, 1, 0];
    const rightCross = [
      camDirNorm[1] * worldUp[2] - camDirNorm[2] * worldUp[1],
      camDirNorm[2] * worldUp[0] - camDirNorm[0] * worldUp[2],
      camDirNorm[0] * worldUp[1] - camDirNorm[1] * worldUp[0]
    ];
    const rightLen = Math.sqrt(rightCross[0] ** 2 + rightCross[1] ** 2 + rightCross[2] ** 2);
    const camRight = [rightCross[0] / rightLen, rightCross[1] / rightLen, rightCross[2] / rightLen];

    const camUp = [
      camRight[1] * camDirNorm[2] - camRight[2] * camDirNorm[1],
      camRight[2] * camDirNorm[0] - camRight[0] * camDirNorm[2],
      camRight[0] * camDirNorm[1] - camRight[1] * camDirNorm[0]
    ];

    const totalPixels = actualRenderWidth * actualRenderHeight;
    const startPixel = Math.floor(startProgress * totalPixels);
    let pixelsRendered = startPixel;

    const hashPixelSeed = (tileIndex: number, px: number, py: number, sampleIndex: number): number => {
      let h = tileIndex * 374761393;
      h = (h + px * 668265263) | 0;
      h = (h + py * 2147483647) | 0;
      h = (h + sampleIndex * 1013904223) | 0;
      h = ((h ^ (h >> 13)) * 1274126177) | 0;
      return h >>> 0;
    };

    class SeededRNG {
      private state: number;
      constructor(seed: number) {
        this.state = seed;
      }
      next(): number {
        this.state = (this.state * 1664525 + 1013904223) & 0xFFFFFFFF;
        return (this.state >>> 0) / 0xFFFFFFFF;
      }
    }

    const vec3Normalize = (v: number[]): number[] => {
      const len = Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2);
      if (len === 0) return [0, 0, 0];
      return [v[0] / len, v[1] / len, v[2] / len];
    };

    const sceneHit = (origin: number[], direction: number[]): any => {
      let closest: any = null;
      let closestT = Infinity;

      for (const sphere of scene.spheres) {
        const oc = [
          origin[0] - sphere.center[0],
          origin[1] - sphere.center[1],
          origin[2] - sphere.center[2]
        ];
        const a = direction[0] ** 2 + direction[1] ** 2 + direction[2] ** 2;
        const halfB = oc[0] * direction[0] + oc[1] * direction[1] + oc[2] * direction[2];
        const c = oc[0] ** 2 + oc[1] ** 2 + oc[2] ** 2 - sphere.radius * sphere.radius;
        const discriminant = halfB * halfB - a * c;

        if (discriminant >= 0) {
          const sqrtD = Math.sqrt(discriminant);
          let t = (-halfB - sqrtD) / a;
          if (t < 0.001 || t > closestT) {
            t = (-halfB + sqrtD) / a;
          }
          if (t >= 0.001 && t < closestT) {
            closestT = t;
            const point = [
              origin[0] + direction[0] * t,
              origin[1] + direction[1] * t,
              origin[2] + direction[2] * t
            ];
            const normal = vec3Normalize([
              point[0] - sphere.center[0],
              point[1] - sphere.center[1],
              point[2] - sphere.center[2]
            ]);
            closest = { point, normal, material: sphere.material };
          }
        }
      }

      for (const plane of scene.planes) {
        const denom = plane.normal[0] * direction[0] + plane.normal[1] * direction[1] + plane.normal[2] * direction[2];
        if (Math.abs(denom) >= 0.0001) {
          const planeVec = [
            plane.point[0] - origin[0],
            plane.point[1] - origin[1],
            plane.point[2] - origin[2]
          ];
          const t = (planeVec[0] * plane.normal[0] + planeVec[1] * plane.normal[1] + planeVec[2] * plane.normal[2]) / denom;
          if (t >= 0.001 && t < closestT) {
            closestT = t;
            const point = [
              origin[0] + direction[0] * t,
              origin[1] + direction[1] * t,
              origin[2] + direction[2] * t
            ];
            let normal = plane.normal;
            if (denom > 0) {
              normal = [-normal[0], -normal[1], -normal[2]];
            }
            closest = { point, normal, material: plane.material };
          }
        }
      }

      return closest;
    };

    const traceRay = (origin: number[], direction: number[], depth: number, rng: SeededRNG): number[] => {
      if (depth <= 0) return [0, 0, 0];

      const hit = sceneHit(origin, direction);

      if (!hit) {
        const t = 0.5 * (direction[1] + 1);
        return [
          (1 - t) * 1.0 + t * 0.5,
          (1 - t) * 1.0 + t * 0.7,
          (1 - t) * 1.0 + t * 1.0
        ];
      }

      const { point, normal, material } = hit;

      if (material.type === 'emissive' && material.emission) {
        return material.emission;
      }

      let scattered: number[];
      const attenuation = material.color;

      if (material.type === 'metal') {
        const d = direction[0] * normal[0] + direction[1] * normal[1] + direction[2] * normal[2];
        const reflected = [
          direction[0] - 2 * d * normal[0],
          direction[1] - 2 * d * normal[1],
          direction[2] - 2 * d * normal[2]
        ];
        const fuzz = material.roughness || 0;
        let rx: number, ry: number, rz: number;
        do {
          rx = rng.next() * 2 - 1;
          ry = rng.next() * 2 - 1;
          rz = rng.next() * 2 - 1;
        } while (rx * rx + ry * ry + rz * rz > 1 || rx * rx + ry * ry + rz * rz < 0.01);
        const fuzzVec = vec3Normalize([rx, ry, rz]);
        scattered = vec3Normalize([
          reflected[0] + fuzzVec[0] * fuzz,
          reflected[1] + fuzzVec[1] * fuzz,
          reflected[2] + fuzzVec[2] * fuzz
        ]);
        if (scattered[0] * normal[0] + scattered[1] * normal[1] + scattered[2] * normal[2] < 0) {
          return [0, 0, 0];
        }
      } else {
        let rx: number, ry: number, rz: number;
        do {
          rx = rng.next() * 2 - 1;
          ry = rng.next() * 2 - 1;
          rz = rng.next() * 2 - 1;
        } while (rx * rx + ry * ry + rz * rz > 1 || rx * rx + ry * ry + rz * rz < 0.01);
        const randVec = vec3Normalize([rx, ry, rz]);
        if (randVec[0] * normal[0] + randVec[1] * normal[1] + randVec[2] * normal[2] < 0) {
          scattered = vec3Normalize([
            normal[0] - randVec[0],
            normal[1] - randVec[1],
            normal[2] - randVec[2]
          ]);
        } else {
          scattered = vec3Normalize([
            normal[0] + randVec[0],
            normal[1] + randVec[1],
            normal[2] + randVec[2]
          ]);
        }
      }

      const incoming = traceRay(point, scattered, depth - 1, rng);
      return [
        attenuation[0] * incoming[0],
        attenuation[1] * incoming[1],
        attenuation[2] * incoming[2]
      ];
    };

    const clamp = (x: number, min: number, max: number): number => Math.max(min, Math.min(max, x));

    const startPy = Math.floor(startPixel / actualRenderWidth);
    const startPx = startPixel % actualRenderWidth;

    for (let py = startPy; py < actualRenderHeight; py++) {
      for (let px = (py === startPy ? startPx : 0); px < actualRenderWidth; px++) {
        if (cancelRequestedRef.current) {
          return { pixelData, coreWidth: actualRenderWidth, coreHeight: actualRenderHeight, cancelled: true };
        }

        const globalPx = clampedRenderX + px;
        const globalPy = clampedRenderY + py;

        let color: number[] = [0, 0, 0];

        for (let s = 0; s < samplesPerPixel; s++) {
          const sampleSeed = hashPixelSeed(tile.index, globalPx, globalPy, s);
          const rng = new SeededRNG(sampleSeed);

          const jitterX = rng.next();
          const jitterY = rng.next();

          const u = ((globalPx + jitterX) / width) * 2 - 1;
          const v = 1 - ((globalPy + jitterY) / height) * 2;

          const rayDir = vec3Normalize([
            camDirNorm[0] + camRight[0] * u * viewportWidth / 2 + camUp[0] * v * viewportHeight / 2,
            camDirNorm[1] + camRight[1] * u * viewportWidth / 2 + camUp[1] * v * viewportHeight / 2,
            camDirNorm[2] + camRight[2] * u * viewportWidth / 2 + camUp[2] * v * viewportHeight / 2
          ]);

          const sampleColor = traceRay(camPos, rayDir, 5, rng);
          color[0] += sampleColor[0];
          color[1] += sampleColor[1];
          color[2] += sampleColor[2];
        }

        color = [color[0] / samplesPerPixel, color[1] / samplesPerPixel, color[2] / samplesPerPixel];

        const r = Math.floor(clamp(Math.pow(color[0], 0.45), 0, 1) * 255);
        const g = Math.floor(clamp(Math.pow(color[1], 0.45), 0, 1) * 255);
        const b = Math.floor(clamp(Math.pow(color[2], 0.45), 0, 1) * 255);

        const idx = (py * actualRenderWidth + px) * 4;
        pixelData[idx] = r;
        pixelData[idx + 1] = g;
        pixelData[idx + 2] = b;
        pixelData[idx + 3] = 255;

        pixelsRendered++;
        if (pixelsRendered % 50 === 0) {
          const currentProgress = pixelsRendered / totalPixels;
          setProgress(currentProgress);
          if (dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
            sendProgressUpdate(dataChannelRef.current, currentProgress);
          }

          if (pixelsRendered % 200 === 0) {
            saveResumeState(tile, currentProgress, pixelData);
          }

          if (canvasRef.current) {
            const ctx = canvasRef.current.getContext('2d');
            if (ctx) {
              canvasRef.current.width = actualRenderWidth;
              canvasRef.current.height = actualRenderHeight;
              const imgData = new ImageData(new Uint8ClampedArray(pixelData), actualRenderWidth, actualRenderHeight);
              ctx.putImageData(imgData, 0, 0);
            }
          }
        }
      }

      if (py % 5 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    setProgress(1);
    if (dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
      sendProgressUpdate(dataChannelRef.current, 1);
    }

    return { pixelData, coreWidth: actualRenderWidth, coreHeight: actualRenderHeight, cancelled: false };
  }, [saveResumeState]);

  const handleTileTask = useCallback(async (tile: Tile, scene: SceneData, resumeProgress: number = 0) => {
    if (isRenderingRef.current) {
      console.warn('Received tile task while already rendering');
      return;
    }

    cancelRequestedRef.current = false;
    isRenderingRef.current = true;
    currentTileIdRef.current = tile.id;
    setCurrentTile(tile);
    setStatus('rendering');
    setProgress(resumeProgress);
    setSceneData(scene);
    setCancelReason('');

    try {
      const result = await renderTileWithCancel(tile, scene, resumeProgress);

      if (result.cancelled) {
        console.log('Tile rendering cancelled:', tile.id, 'Reason:', cancelReason);
        saveResumeState(tile, progress, result.pixelData);
        return;
      }

      if (canvasRef.current) {
        const ctx = canvasRef.current.getContext('2d');
        if (ctx) {
          canvasRef.current.width = result.coreWidth;
          canvasRef.current.height = result.coreHeight;
          const imgData = new ImageData(new Uint8ClampedArray(result.pixelData), result.coreWidth, result.coreHeight);
          ctx.putImageData(imgData, 0, 0);
        }
      }

      const tileResult: TileResult = {
        tileId: tile.id,
        x: tile.x,
        y: tile.y,
        width: tile.width,
        height: tile.height,
        overlap: tile.overlap,
        pixelData: result.pixelData,
        renderTime: 0,
        coreWidth: result.coreWidth,
        coreHeight: result.coreHeight
      } as any;

      if (dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
        sendTileResult(dataChannelRef.current, tileResult);
      }

      setTilesRendered(prev => prev + 1);
      clearResumeState();

    } catch (error) {
      console.error('Error rendering tile:', error);
      setError('渲染出错');
      saveResumeState(tile, progress, null);
    } finally {
      isRenderingRef.current = false;
      currentTileIdRef.current = null;
      setCurrentTile(null);
      if (!cancelRequestedRef.current) {
        setStatus('waiting');
      }
      setProgress(0);
    }
  }, [renderTileWithCancel, progress, saveResumeState, clearResumeState, cancelReason]);

  const handleIncrementalTileTask = useCallback(async (task: IncrementalTileTask) => {
    if (isRenderingRef.current) {
      console.warn('Received incremental tile task while already rendering, cancelling previous');
      cancelRequestedRef.current = true;
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    const { tile, sceneData: scene, startSample, endSample, batchId } = task;

    cancelRequestedRef.current = false;
    isRenderingRef.current = true;
    currentTileIdRef.current = tile.id;
    setCurrentTile(tile);
    setStatus('rendering');
    setProgress(0);
    setSceneData(scene);
    setCancelReason('');
    setCurrentBatchId(batchId);
    setSampleRange({ start: startSample, end: endSample });

    try {
      const result = renderTileIncremental(
        scene,
        tile.x, tile.y, tile.width, tile.height,
        tile.index,
        tile.overlap,
        startSample,
        endSample,
        (progress) => {
          setProgress(progress);
          if (dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
            sendProgressUpdate(dataChannelRef.current, progress);
          }
        },
        () => cancelRequestedRef.current
      );

      if (result.cancelled) {
        console.log('Incremental tile rendering cancelled:', tile.id, 'Reason:', cancelReason);
        return;
      }

      const tileResult = {
        tileId: tile.id,
        x: tile.x,
        y: tile.y,
        width: tile.width,
        height: tile.height,
        overlap: tile.overlap,
        accumulatedColor: Array.from(result.accumulatedColor),
        sampleCount: endSample - startSample,
        batchId,
        renderTime: 0,
        coreWidth: result.coreWidth,
        coreHeight: result.coreHeight
      };

      if (dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
        sendIncrementalTileResult(dataChannelRef.current, tileResult as any);
      }

      setTilesRendered(prev => prev + 1);

    } catch (error) {
      console.error('Error rendering incremental tile:', error);
      setError('渲染出错');
    } finally {
      isRenderingRef.current = false;
      currentTileIdRef.current = null;
      setCurrentTile(null);
      setCurrentBatchId(null);
      setSampleRange(null);
      if (!cancelRequestedRef.current) {
        setStatus('waiting');
      }
      setProgress(0);
    }
  }, [cancelReason]);

  const handleSchedulerMessage = useCallback((message: any) => {
    switch (message.type) {
      case 'tile-task':
        handleTileTask(message.tile, message.sceneData, 0);
        break;

      case 'incremental-tile-task':
        handleIncrementalTileTask(message.task);
        break;

      case 'heartbeat':
        if (dataChannelRef.current) {
          sendHeartbeatAck(dataChannelRef.current, message.timestamp);
          const measuredLatency = Date.now() - message.timestamp;
          setLatency(measuredLatency);
        }
        break;

      case 'cancel-tile':
        if (isRenderingRef.current && currentTileIdRef.current === message.tileId) {
          console.log('Cancelling tile:', message.tileId, 'Reason:', message.reason);
          cancelRequestedRef.current = true;
          setCancelReason(message.reason || '');
          setStatus('cancelling');
        }
        break;

      case 'resume-state':
        const resumeState: WorkerResumeState = message.resumeState;
        console.log('Received resume state:', resumeState);
        if (resumeState.currentTile && sceneDataRef.current) {
          console.log('Resuming tile from progress:', resumeState.tileProgress);
          handleTileTask(
            resumeState.currentTile,
            sceneDataRef.current,
            resumeState.tileProgress || 0
          );
        } else if (resumeState.currentTile) {
          setError('缺少场景数据，无法续传瓦片');
        }
        break;

      default:
        console.warn('Unknown message type:', message.type);
    }
  }, [handleTileTask, handleIncrementalTileTask]);

  useEffect(() => {
    if (status === 'waiting' && reconnectToken) {
      const resumeState = loadResumeState();
      if (resumeState && resumeState.currentTile && resumeState.reconnectToken === reconnectToken) {
        console.log('Found saved resume state, will notify scheduler');
      }
    }
  }, [status, reconnectToken, loadResumeState]);

  const goHome = () => {
    cancelRequestedRef.current = true;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
    }
    if (peerConnectionRef.current) {
      try {
        peerConnectionRef.current.close();
      } catch (e) {
        console.warn('Failed to close peer connection:', e);
      }
    }
    navigate('/');
  };

  const statusText: Record<WorkerStatus, string> = {
    connecting: '连接中...',
    waiting: '等待任务...',
    rendering: '渲染中...',
    disconnected: '已断开',
    reconnecting: '重连中...',
    cancelling: '取消中...'
  };

  const latencyText = latency >= 0 ? `${latency}ms` : '-';
  const latencyClass = latency < 0 ? '' : latency < 100 ? 'latency-good' : latency < 300 ? 'latency-moderate' : 'latency-high';

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
          <div className="worker-header-right">
            <div className="worker-room-info">
              <span className="room-label">房间:</span>
              <span className="room-code">{roomId}</span>
            </div>
            {latency >= 0 && (
              <div className={`latency-badge ${latencyClass}`}>
                延迟: {latencyText}
              </div>
            )}
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
                {status === 'reconnecting' && (
                  <span className="status-icon">🔄</span>
                )}
                {status === 'cancelling' && (
                  <span className="status-icon">⏹</span>
                )}
              </div>
            </div>
            <h2 className="status-text">{statusText[status]}</h2>
            <p className="worker-name-display">{workerName}</p>
            {reconnectAttempts > 0 && status === 'reconnecting' && (
              <p className="reconnect-hint">第 {reconnectAttempts} 次重连尝试...</p>
            )}
            {status === 'cancelling' && cancelReason && (
              <p className="cancel-reason">取消原因: {cancelReason}</p>
            )}
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
                {status === 'disconnected' ? '离线' : status === 'reconnecting' ? '重连中' : '在线'}
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
                {currentTile.overlap && (
                  <span>重叠: {Math.max(currentTile.overlap.top, currentTile.overlap.bottom, currentTile.overlap.left, currentTile.overlap.right)}px</span>
                )}
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
              {status === 'disconnected' && (
                <button className="btn-reconnect" onClick={attemptReconnect}>
                  🔄 手动重连
                </button>
              )}
            </div>
          )}

          {status === 'waiting' && tilesRendered === 0 && (
            <div className="waiting-hint">
              <div className="hint-icon">💡</div>
              <p>您的浏览器已准备就绪，正在等待调度器分配渲染任务...</p>
              <p className="hint-sub">请确保调度器已开始渲染</p>
              {reconnectToken && (
                <p className="hint-sub mt-4">🔐 续传令牌已启用，断线后可自动续传</p>
              )}
            </div>
          )}

          {status === 'reconnecting' && (
            <div className="reconnecting-card">
              <div className="hint-icon">🔄</div>
              <p>连接中断，正在尝试自动重连...</p>
              <p className="hint-sub">请保持页面打开，续传进度将在重连后自动恢复</p>
              <div className="reconnect-spinner"></div>
            </div>
          )}
        </div>

        <div className="worker-footer">
          <div className="tech-info">
            <span className="tech-badge">⚡ WebAssembly 加速</span>
            <span className="tech-badge">🔗 WebRTC P2P</span>
            <span className="tech-badge">🎯 路径追踪</span>
            <span className="tech-badge resume-badge">🔐 断线续传</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Worker;
