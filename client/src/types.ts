export interface Tile {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  index: number;
}

export interface WorkerInfo {
  id: string;
  name: string;
  status: 'idle' | 'rendering' | 'disconnected';
  progress: number;
  currentTile: Tile | null;
  tilesRendered: number;
  joinedAt: number;
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
}

export type RenderStatus = 'idle' | 'ready' | 'rendering' | 'completed';

export interface TileResult {
  tileId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pixelData: Uint8ClampedArray;
}
