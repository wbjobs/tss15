export interface Tile {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  index: number;
  overlap: TileOverlap;
  seed: number;
}

export interface TileOverlap {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface WorkerInfo {
  id: string;
  name: string;
  status: 'idle' | 'rendering' | 'disconnected' | 'slow' | 'timeout';
  progress: number;
  currentTile: Tile | null;
  tilesRendered: number;
  joinedAt: number;
  lastHeartbeat: number;
  avgRenderTime: number;
  assignedAt: number | null;
  timeoutCount: number;
  reconnectToken: string | null;
  dataChannel?: RTCDataChannel;
}

export interface SceneData {
  width: number;
  height: number;
  samplesPerPixel: number;
  spheres: Sphere[];
  planes: Plane[];
  camera: Camera;
}

export interface Sphere {
  center: [number, number, number];
  radius: number;
  material: Material;
}

export interface Plane {
  point: [number, number, number];
  normal: [number, number, number];
  material: Material;
}

export interface Camera {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

export interface Material {
  color: [number, number, number];
  type: 'diffuse' | 'metal' | 'emissive';
  roughness?: number;
  emission?: [number, number, number];
}

export interface RenderParams {
  width: number;
  height: number;
  samplesPerPixel: number;
  tileSize: number;
  totalTiles: number;
  overlapSize: number;
}

export type RenderStatus = 'idle' | 'ready' | 'rendering' | 'completed';

export interface TileResult {
  tileId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  overlap: TileOverlap;
  pixelData: Uint8ClampedArray;
  renderTime: number;
}

export interface TimeoutConfig {
  warningThreshold: number;
  kickThreshold: number;
  heartbeatInterval: number;
  progressStallTimeout: number;
}

export const DEFAULT_TIMEOUT_CONFIG: TimeoutConfig = {
  warningThreshold: 15000,
  kickThreshold: 30000,
  heartbeatInterval: 3000,
  progressStallTimeout: 20000
};

export interface ReassignmentLog {
  tileId: string;
  fromWorkerId: string;
  fromWorkerName: string;
  toWorkerId: string;
  toWorkerName: string;
  reason: 'timeout' | 'disconnected' | 'slow';
  timestamp: number;
}

export interface WorkerResumeState {
  workerId: string;
  workerName: string;
  reconnectToken: string;
  currentTile: Tile | null;
  tileProgress: number;
  partialPixelData: Uint8ClampedArray | null;
}

export interface IncrementalTileTask {
  tile: Tile;
  sceneData: SceneData;
  startSample: number;
  endSample: number;
  batchId: string;
}

export interface IncrementalTileResult {
  tileId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  overlap: TileOverlap;
  accumulatedColor: Float32Array;
  sampleCount: number;
  batchId: string;
  renderTime: number;
  coreWidth: number;
  coreHeight: number;
}

export interface AccumulationBuffer {
  width: number;
  height: number;
  colorData: Float32Array;
  sampleCount: Uint32Array;
}

export type ProgressiveStatus = 'idle' | 'rendering' | 'paused' | 'completed';

export interface TileProgressLog {
  tileId: string;
  tileIndex: number;
  workerId: string;
  workerName: string;
  startTime: number;
  endTime: number;
  samplesRendered: number;
}

export interface RenderTaskRecord {
  id: string;
  name: string;
  createdAt: number;
  completedAt?: number;
  status: 'in_progress' | 'completed' | 'failed';
  sceneName: string;
  width: number;
  height: number;
  totalSamples: number;
  tileSize: number;
  overlapSize: number;
  workers: WorkerInfo[];
  tileProgressLogs: TileProgressLog[];
  finalImageData?: string;
  thumbnailData?: string;
  params: {
    samplesPerPixel: number;
    lightIntensity?: number;
    fov?: number;
  };
}

export interface GalleryCompareItem {
  taskId: string;
  taskName: string;
  thumbnailData: string;
  params: RenderTaskRecord['params'];
}

export const DEFAULT_BATCH_SAMPLES = 10;
export const DEFAULT_TARGET_SAMPLES = 100;
export const MIN_TARGET_SAMPLES = 10;
export const MAX_TARGET_SAMPLES = 1000;
