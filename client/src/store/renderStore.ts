import { create } from 'zustand';
import type { WorkerInfo, Tile, SceneData, TileResult, RenderStatus, RenderParams } from '../types';

interface RenderState {
  roomId: string | null;
  role: 'scheduler' | 'worker' | null;
  status: RenderStatus;
  workers: Map<string, WorkerInfo>;
  tiles: Tile[];
  completedTiles: Set<string>;
  pendingTiles: Tile[];
  sceneData: SceneData | null;
  renderParams: RenderParams | null;
  finalImageData: ImageData | null;
  error: string | null;

  setRoomId: (id: string | null) => void;
  setRole: (role: 'scheduler' | 'worker' | null) => void;
  setStatus: (status: RenderStatus) => void;
  setSceneData: (data: SceneData | null) => void;
  setRenderParams: (params: RenderParams | null) => void;
  setError: (error: string | null) => void;

  addWorker: (worker: WorkerInfo) => void;
  removeWorker: (workerId: string) => void;
  updateWorker: (workerId: string, updates: Partial<WorkerInfo>) => void;

  setTiles: (tiles: Tile[]) => void;
  addCompletedTile: (result: TileResult) => void;
  getNextTile: () => Tile | null;

  setFinalImageData: (data: ImageData | null) => void;
  reset: () => void;
}

export const useRenderStore = create<RenderState>((set, get) => ({
  roomId: null,
  role: null,
  status: 'idle',
  workers: new Map(),
  tiles: [],
  completedTiles: new Set(),
  pendingTiles: [],
  sceneData: null,
  renderParams: null,
  finalImageData: null,
  error: null,

  setRoomId: (id) => set({ roomId: id }),
  setRole: (role) => set({ role }),
  setStatus: (status) => set({ status }),
  setSceneData: (data) => set({ sceneData: data }),
  setRenderParams: (params) => set({ renderParams: params }),
  setError: (error) => set({ error }),

  addWorker: (worker) => set((state) => {
    const workers = new Map(state.workers);
    workers.set(worker.id, worker);
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

  setTiles: (tiles) => set({ tiles, pendingTiles: [...tiles], completedTiles: new Set() }),

  addCompletedTile: (result) => set((state) => {
    const completedTiles = new Set(state.completedTiles);
    completedTiles.add(result.tileId);

    let finalImageData = state.finalImageData;
    if (!finalImageData && state.sceneData) {
      const { width, height } = state.sceneData;
      finalImageData = new ImageData(width, height);
    }

    if (finalImageData) {
      for (let py = 0; py < result.height; py++) {
        for (let px = 0; px < result.width; px++) {
          const srcIdx = (py * result.width + px) * 4;
          const dstX = result.x + px;
          const dstY = result.y + py;
          const dstIdx = (dstY * finalImageData.width + dstX) * 4;
          
          finalImageData.data[dstIdx] = result.pixelData[srcIdx];
          finalImageData.data[dstIdx + 1] = result.pixelData[srcIdx + 1];
          finalImageData.data[dstIdx + 2] = result.pixelData[srcIdx + 2];
          finalImageData.data[dstIdx + 3] = result.pixelData[srcIdx + 3];
        }
      }
    }

    const totalTiles = state.tiles.length;
    const newStatus = completedTiles.size >= totalTiles ? 'completed' : state.status;

    return { completedTiles, finalImageData, status: newStatus };
  }),

  getNextTile: () => {
    const state = get();
    if (state.pendingTiles.length === 0) return null;
    const tile = state.pendingTiles.shift()!;
    set({ pendingTiles: [...state.pendingTiles] });
    return tile;
  },

  setFinalImageData: (data) => set({ finalImageData: data }),

  reset: () => set({
    status: 'idle',
    tiles: [],
    completedTiles: new Set(),
    pendingTiles: [],
    finalImageData: null
  })
}));
