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
