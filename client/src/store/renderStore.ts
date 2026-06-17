import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type {
  WorkerInfo, Tile, SceneData, TileResult, TileOverlap,
  RenderStatus, RenderParams, TimeoutConfig, ReassignmentLog,
  IncrementalTileResult, TileProgressLog, ProgressiveStatus,
  DEFAULT_BATCH_SAMPLES, DEFAULT_TARGET_SAMPLES
} from '../types';
import { blendOverlapTile, accumulateTileResult, toneMapAndGammaCorrect, createAccumulationBuffer } from '../renderer/pathTracer';

interface RenderState {
  roomId: string | null;
  role: 'scheduler' | 'worker' | null;
  status: RenderStatus;
  progressiveStatus: ProgressiveStatus;
  workers: Map<string, WorkerInfo>;
  tiles: Tile[];
  completedTiles: Set<string>;
  pendingTiles: Tile[];
  inFlightTiles: Map<string, { tile: Tile; workerId: string; assignedAt: number; batchId: string; startSample: number; endSample: number }>;
  sceneData: SceneData | null;
  renderParams: RenderParams | null;
  finalImageData: ImageData | null;
  error: string | null;
  timeoutConfig: TimeoutConfig;
  reassignmentLogs: ReassignmentLog[];
  overlapSize: number;
  workerResumeStates: Map<string, { tile: Tile; progress: number; partialData: Uint8ClampedArray | null }>;

  accumulationBuffer: {
    colorData: Float32Array;
    sampleCount: Uint32Array;
    width: number;
    height: number;
  } | null;
  currentSamples: number;
  targetSamples: number;
  batchSize: number;
  currentBatchId: string | null;
  batchCompletedTiles: Set<string>;
  tileProgressLogs: TileProgressLog[];

  setRoomId: (id: string | null) => void;
  setRole: (role: 'scheduler' | 'worker' | null) => void;
  setStatus: (status: RenderStatus) => void;
  setProgressiveStatus: (status: ProgressiveStatus) => void;
  setSceneData: (data: SceneData | null) => void;
  setRenderParams: (params: RenderParams | null) => void;
  setError: (error: string | null) => void;
  setTimeoutConfig: (config: TimeoutConfig) => void;
  setOverlapSize: (size: number) => void;
  setTargetSamples: (samples: number) => void;
  setBatchSize: (size: number) => void;

  addWorker: (worker: WorkerInfo) => void;
  removeWorker: (workerId: string) => void;
  updateWorker: (workerId: string, updates: Partial<WorkerInfo>) => void;
  updateWorkerHeartbeat: (workerId: string) => void;

  setTiles: (tiles: Tile[]) => void;
  addCompletedTile: (result: TileResult) => void;
  getNextTile: () => Tile | null;
  reassignTileFromWorker: (workerId: string, reason: 'timeout' | 'disconnected' | 'slow') => Tile | null;
  markTileInFlight: (tileId: string, workerId: string, batchId: string, startSample: number, endSample: number) => void;
  removeTileFromFlight: (tileId: string) => void;

  checkWorkerTimeouts: () => string[];
  getWorkerHealth: (workerId: string) => 'healthy' | 'slow' | 'stalled' | 'disconnected';

  saveWorkerResumeState: (workerId: string, tile: Tile, progress: number, partialData: Uint8ClampedArray | null) => void;
  loadWorkerResumeState: (workerId: string) => { tile: Tile; progress: number; partialData: Uint8ClampedArray | null } | null;
  clearWorkerResumeState: (workerId: string) => void;
  handleWorkerReconnect: (workerId: string, newSocketId: string) => void;

  setFinalImageData: (data: ImageData | null) => void;
  reset: () => void;

  initAccumulationBuffer: (width: number, height: number) => void;
  addIncrementalTileResult: (result: IncrementalTileResult & { overlap: TileOverlap; coreWidth: number; coreHeight: number }) => void;
  updateDisplayImage: () => void;
  startNextBatch: () => { batchId: string; startSample: number; endSample: number } | null;
  isBatchComplete: () => boolean;
  addTileProgressLog: (log: TileProgressLog) => void;
  getAverageSamples: () => number;
}

export const useRenderStore = create<RenderState>((set, get) => ({
  roomId: null,
  role: null,
  status: 'idle',
  progressiveStatus: 'idle',
  workers: new Map(),
  tiles: [],
  completedTiles: new Set(),
  pendingTiles: [],
  inFlightTiles: new Map(),
  sceneData: null,
  renderParams: null,
  finalImageData: null,
  error: null,
  timeoutConfig: {
    warningThreshold: 15000,
    kickThreshold: 30000,
    heartbeatInterval: 3000,
    progressStallTimeout: 20000
  },
  reassignmentLogs: [],
  overlapSize: 4,
  workerResumeStates: new Map(),

  accumulationBuffer: null,
  currentSamples: 0,
  targetSamples: 100,
  batchSize: 10,
  currentBatchId: null,
  batchCompletedTiles: new Set(),
  tileProgressLogs: [],

  setRoomId: (id) => set({ roomId: id }),
  setRole: (role) => set({ role }),
  setStatus: (status) => set({ status }),
  setProgressiveStatus: (status) => set({ progressiveStatus: status }),
  setSceneData: (data) => set({ sceneData: data }),
  setRenderParams: (params) => set({ renderParams: params }),
  setError: (error) => set({ error }),
  setTimeoutConfig: (config) => set({ timeoutConfig: config }),
  setOverlapSize: (size) => set({ overlapSize: size }),
  setTargetSamples: (samples) => set({ targetSamples: Math.max(1, samples) }),
  setBatchSize: (size) => set({ batchSize: Math.max(1, size) }),

  addWorker: (worker) => set((state) => {
    const workers = new Map(state.workers);
    workers.set(worker.id, {
      ...worker,
      lastHeartbeat: Date.now(),
      avgRenderTime: 0,
      assignedAt: null,
      timeoutCount: 0,
      reconnectToken: worker.reconnectToken || null
    });
    return { workers };
  }),

  removeWorker: (workerId) => set((state) => {
    const workers = new Map(state.workers);
    workers.delete(workerId);
    return { workers };
  }),

  updateWorker: (workerId, updates) => set((state) => {
    const workers = new Map(state.workers);
    const worker = workers.get(workerId);
    if (worker) {
      workers.set(workerId, { ...worker, ...updates });
    }
    return { workers };
  }),

  updateWorkerHeartbeat: (workerId) => set((state) => {
    const workers = new Map(state.workers);
    const worker = workers.get(workerId);
    if (worker) {
      workers.set(workerId, { ...worker, lastHeartbeat: Date.now() });
    }
    return { workers };
  }),

  setTiles: (tiles) => set({
    tiles,
    pendingTiles: [...tiles],
    completedTiles: new Set(),
    inFlightTiles: new Map(),
    batchCompletedTiles: new Set()
  }),

  addCompletedTile: (result) => set((state) => {
    const completedTiles = new Set(state.completedTiles);
    completedTiles.add(result.tileId);

    let finalImageData = state.finalImageData;
    if (!finalImageData && state.sceneData) {
      const { width, height } = state.sceneData;
      finalImageData = new ImageData(width, height);
    }

    if (finalImageData) {
      blendOverlapTile(finalImageData, {
        x: result.x,
        y: result.y,
        width: result.width,
        height: result.height,
        overlap: result.overlap,
        pixelData: result.pixelData,
        coreWidth: (result as any).coreWidth || result.width,
        coreHeight: (result as any).coreHeight || result.height
      });
    }

    const inFlightTiles = new Map(state.inFlightTiles);
    inFlightTiles.delete(result.tileId);

    const totalTiles = state.tiles.length;
    const newStatus = completedTiles.size >= totalTiles ? 'completed' : state.status;

    return { completedTiles, finalImageData, inFlightTiles, status: newStatus };
  }),

  getNextTile: () => {
    const state = get();
    if (state.pendingTiles.length === 0) return null;
    const tile = state.pendingTiles.shift()!;
    set({ pendingTiles: [...state.pendingTiles] });
    return tile;
  },

  markTileInFlight: (tileId, workerId, batchId, startSample, endSample) => set((state) => {
    const inFlightTiles = new Map(state.inFlightTiles);
    const tile = state.tiles.find(t => t.id === tileId);
    if (tile) {
      inFlightTiles.set(tileId, { tile, workerId, assignedAt: Date.now(), batchId, startSample, endSample });
    }
    return { inFlightTiles };
  }),

  removeTileFromFlight: (tileId) => set((state) => {
    const inFlightTiles = new Map(state.inFlightTiles);
    inFlightTiles.delete(tileId);
    return { inFlightTiles };
  }),

  reassignTileFromWorker: (workerId, reason) => {
    const state = get();
    const worker = state.workers.get(workerId);
    if (!worker || !worker.currentTile) return null;

    const tile = worker.currentTile;

    const inFlightTiles = new Map(state.inFlightTiles);
    inFlightTiles.delete(tile.id);

    const pendingTiles = [...state.pendingTiles, tile];

    const workers = new Map(state.workers);
    workers.set(workerId, {
      ...worker,
      currentTile: null,
      status: reason === 'disconnected' ? 'disconnected' : 'timeout',
      timeoutCount: worker.timeoutCount + 1
    });

    const log: ReassignmentLog = {
      tileId: tile.id,
      fromWorkerId: workerId,
      fromWorkerName: worker.name,
      toWorkerId: '',
      toWorkerName: '',
      reason,
      timestamp: Date.now()
    };

    const reassignmentLogs = [...state.reassignmentLogs, log];

    const batchCompletedTiles = new Set(state.batchCompletedTiles);
    batchCompletedTiles.delete(tile.id);

    set({ pendingTiles, inFlightTiles, workers, reassignmentLogs, batchCompletedTiles });
    return tile;
  },

  checkWorkerTimeouts: () => {
    const state = get();
    const now = Date.now();
    const timedOutWorkers: string[] = [];

    state.workers.forEach((worker, workerId) => {
      if (worker.status === 'disconnected') return;

      const heartbeatAge = now - worker.lastHeartbeat;
      const isStalled = worker.status === 'rendering' && worker.assignedAt &&
        (now - worker.assignedAt) > state.timeoutConfig.progressStallTimeout &&
        worker.progress < 0.1;

      if (heartbeatAge > state.timeoutConfig.kickThreshold || isStalled) {
        timedOutWorkers.push(workerId);
      }
    });

    return timedOutWorkers;
  },

  getWorkerHealth: (workerId) => {
    const state = get();
    const worker = state.workers.get(workerId);
    if (!worker) return 'disconnected';
    if (worker.status === 'disconnected') return 'disconnected';

    const now = Date.now();
    const heartbeatAge = now - worker.lastHeartbeat;

    if (heartbeatAge > state.timeoutConfig.kickThreshold) return 'disconnected';
    if (heartbeatAge > state.timeoutConfig.warningThreshold) return 'stalled';
    if (worker.status === 'rendering' && worker.assignedAt) {
      const renderTime = now - worker.assignedAt;
      if (worker.avgRenderTime > 0 && renderTime > worker.avgRenderTime * 3) {
        return 'slow';
      }
    }
    return 'healthy';
  },

  saveWorkerResumeState: (workerId, tile, progress, partialData) => set((state) => {
    const workerResumeStates = new Map(state.workerResumeStates);
    workerResumeStates.set(workerId, { tile, progress, partialData });
    return { workerResumeStates };
  }),

  loadWorkerResumeState: (workerId) => {
    const state = get();
    return state.workerResumeStates.get(workerId) || null;
  },

  clearWorkerResumeState: (workerId) => set((state) => {
    const workerResumeStates = new Map(state.workerResumeStates);
    workerResumeStates.delete(workerId);
    return { workerResumeStates };
  }),

  handleWorkerReconnect: (workerId, newSocketId) => set((state) => {
    const workers = new Map(state.workers);
    const oldWorker = workers.get(workerId);

    if (oldWorker) {
      workers.set(newSocketId, {
        ...oldWorker,
        id: newSocketId,
        status: 'idle',
        lastHeartbeat: Date.now()
      });
      workers.delete(workerId);
    }

    const inFlightTiles = new Map(state.inFlightTiles);
    inFlightTiles.forEach((entry, tileId) => {
      if (entry.workerId === workerId) {
        inFlightTiles.set(tileId, { ...entry, workerId: newSocketId });
      }
    });

    return { workers, inFlightTiles };
  }),

  setFinalImageData: (data) => set({ finalImageData: data }),

  reset: () => set({
    status: 'idle',
    progressiveStatus: 'idle',
    tiles: [],
    completedTiles: new Set(),
    pendingTiles: [],
    inFlightTiles: new Map(),
    finalImageData: null,
    reassignmentLogs: [],
    workerResumeStates: new Map(),
    accumulationBuffer: null,
    currentSamples: 0,
    currentBatchId: null,
    batchCompletedTiles: new Set(),
    tileProgressLogs: []
  }),

  initAccumulationBuffer: (width, height) => {
    const buffer = createAccumulationBuffer(width, height);
    const finalImageData = new ImageData(width, height);
    set({ accumulationBuffer: buffer, finalImageData, currentSamples: 0 });
  },

  addIncrementalTileResult: (result) => set((state) => {
    if (!state.accumulationBuffer) {
      return state;
    }

    const buffer = {
      colorData: new Float32Array(state.accumulationBuffer.colorData),
      sampleCount: new Uint32Array(state.accumulationBuffer.sampleCount),
      width: state.accumulationBuffer.width,
      height: state.accumulationBuffer.height
    };

    accumulateTileResult(buffer, result);

    const batchCompletedTiles = new Set(state.batchCompletedTiles);
    batchCompletedTiles.add(result.tileId);

    const inFlightTiles = new Map(state.inFlightTiles);
    inFlightTiles.delete(result.tileId);

    let finalImageData = state.finalImageData;
    if (finalImageData) {
      finalImageData = new ImageData(
        new Uint8ClampedArray(finalImageData.data),
        finalImageData.width,
        finalImageData.height
      );
    }

    return {
      accumulationBuffer: buffer,
      batchCompletedTiles,
      inFlightTiles,
      finalImageData
    };
  }),

  updateDisplayImage: () => set((state) => {
    if (!state.accumulationBuffer || !state.finalImageData) {
      return state;
    }

    const finalImageData = new ImageData(
      new Uint8ClampedArray(state.finalImageData.data),
      state.finalImageData.width,
      state.finalImageData.height
    );

    toneMapAndGammaCorrect(state.accumulationBuffer, finalImageData);

    return { finalImageData };
  }),

  startNextBatch: () => {
    const state = get();
    if (state.currentSamples >= state.targetSamples) {
      return null;
    }

    const startSample = state.currentSamples;
    const endSample = Math.min(state.currentSamples + state.batchSize, state.targetSamples);
    const batchId = uuidv4();

    const pendingTiles = [...state.tiles];

    set({
      currentBatchId: batchId,
      pendingTiles,
      batchCompletedTiles: new Set(),
      progressiveStatus: 'rendering',
      status: 'rendering'
    });

    return { batchId, startSample, endSample };
  },

  isBatchComplete: () => {
    const state = get();
    return state.batchCompletedTiles.size >= state.tiles.length && state.inFlightTiles.size === 0;
  },

  addTileProgressLog: (log) => set((state) => ({
    tileProgressLogs: [...state.tileProgressLogs, log]
  })),

  getAverageSamples: () => {
    const state = get();
    if (!state.accumulationBuffer) return 0;
    const { sampleCount, width, height } = state.accumulationBuffer;
    let total = 0;
    for (let i = 0; i < sampleCount.length; i++) {
      total += sampleCount[i];
    }
    return total / (width * height);
  }
}));
