import type { SceneData, Sphere, Plane, Material, TileOverlap } from '../types';

type Vec3 = [number, number, number];

class SeededRNG {
  private state: number;

  constructor(seed: number) {
    this.state = seed;
  }

  next(): number {
    this.state = (this.state * 1664525 + 1013904223) & 0xFFFFFFFF;
    return (this.state >>> 0) / 0xFFFFFFFF;
  }

  nextRange(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  fork(seed: number): SeededRNG {
    return new SeededRNG(this.state ^ seed);
  }
}

function vec3Add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function vec3Sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function vec3Mul(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function vec3MulVec(a: Vec3, b: Vec3): Vec3 {
  return [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
}

function vec3Dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function vec3Length(v: Vec3): number {
  return Math.sqrt(vec3Dot(v, v));
}

function vec3Normalize(v: Vec3): Vec3 {
  const len = vec3Length(v);
  if (len === 0) return [0, 0, 0];
  return vec3Mul(v, 1 / len);
}

function vec3Negate(v: Vec3): Vec3 {
  return [-v[0], -v[1], -v[2]];
}

function seededRandomUnitVector(rng: SeededRNG): Vec3 {
  let x: number, y: number, z: number;
  do {
    x = rng.next() * 2 - 1;
    y = rng.next() * 2 - 1;
    z = rng.next() * 2 - 1;
  } while (x * x + y * y + z * z > 1 || x * x + y * y + z * z < 0.01);
  return vec3Normalize([x, y, z]);
}

function reflect(v: Vec3, n: Vec3): Vec3 {
  const d = vec3Dot(v, n) * 2;
  return vec3Sub(v, vec3Mul(n, d));
}

function clamp(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, x));
}

interface HitRecord {
  t: number;
  point: Vec3;
  normal: Vec3;
  material: Material;
}

function hitSphere(
  sphere: Sphere,
  origin: Vec3,
  direction: Vec3,
  tMin: number,
  tMax: number
): HitRecord | null {
  const oc = vec3Sub(origin, sphere.center);
  const a = vec3Dot(direction, direction);
  const halfB = vec3Dot(oc, direction);
  const c = vec3Dot(oc, oc) - sphere.radius * sphere.radius;
  const discriminant = halfB * halfB - a * c;

  if (discriminant < 0) return null;

  const sqrtD = Math.sqrt(discriminant);
  let t = (-halfB - sqrtD) / a;
  if (t < tMin || t > tMax) {
    t = (-halfB + sqrtD) / a;
    if (t < tMin || t > tMax) return null;
  }

  const point: Vec3 = [
    origin[0] + direction[0] * t,
    origin[1] + direction[1] * t,
    origin[2] + direction[2] * t
  ];
  const normal = vec3Normalize(vec3Sub(point, sphere.center));

  return { t, point, normal, material: sphere.material };
}

function hitPlane(
  plane: Plane,
  origin: Vec3,
  direction: Vec3,
  tMin: number,
  tMax: number
): HitRecord | null {
  const denom = vec3Dot(plane.normal, direction);
  if (Math.abs(denom) < 0.0001) return null;

  const t = vec3Dot(vec3Sub(plane.point, origin), plane.normal) / denom;
  if (t < tMin || t > tMax) return null;

  const point: Vec3 = [
    origin[0] + direction[0] * t,
    origin[1] + direction[1] * t,
    origin[2] + direction[2] * t
  ];

  let normal = plane.normal;
  if (denom > 0) {
    normal = vec3Negate(normal);
  }

  return { t, point, normal, material: plane.material };
}

function sceneHit(
  scene: SceneData,
  origin: Vec3,
  direction: Vec3,
  tMin: number,
  tMax: number
): HitRecord | null {
  let closest: HitRecord | null = null;
  let closestT = tMax;

  for (const sphere of scene.spheres) {
    const hit = hitSphere(sphere, origin, direction, tMin, closestT);
    if (hit) {
      closest = hit;
      closestT = hit.t;
    }
  }

  for (const plane of scene.planes) {
    const hit = hitPlane(plane, origin, direction, tMin, closestT);
    if (hit) {
      closest = hit;
      closestT = hit.t;
    }
  }

  return closest;
}

function traceRay(
  scene: SceneData,
  origin: Vec3,
  direction: Vec3,
  depth: number,
  rng: SeededRNG
): Vec3 {
  if (depth <= 0) return [0, 0, 0];

  const hit = sceneHit(scene, origin, direction, 0.001, Infinity);

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

  let scattered: Vec3;
  let attenuation: Vec3 = material.color;

  if (material.type === 'metal') {
    const reflected = reflect(direction, normal);
    const fuzz = material.roughness || 0;
    const randVec = seededRandomUnitVector(rng);
    scattered = vec3Normalize(vec3Add(reflected, vec3Mul(randVec, fuzz)));
    if (vec3Dot(scattered, normal) < 0) {
      return [0, 0, 0];
    }
  } else {
    const randVec = seededRandomUnitVector(rng);
    if (vec3Dot(randVec, normal) < 0) {
      scattered = vec3Normalize(vec3Add(normal, vec3Negate(randVec)));
    } else {
      scattered = vec3Normalize(vec3Add(normal, randVec));
    }
  }

  const incoming = traceRay(scene, point, scattered, depth - 1, rng);
  return vec3MulVec(attenuation, incoming);
}

function hashPixelSeed(tileIndex: number, px: number, py: number, sampleIndex: number): number {
  let h = tileIndex * 374761393;
  h = (h + px * 668265263) | 0;
  h = (h + py * 2147483647) | 0;
  h = (h + sampleIndex * 1013904223) | 0;
  h = ((h ^ (h >> 13)) * 1274126177) | 0;
  return h >>> 0;
}

export function renderTile(
  scene: SceneData,
  tileX: number,
  tileY: number,
  tileWidth: number,
  tileHeight: number,
  tileIndex: number,
  overlap: TileOverlap,
  onProgress?: (progress: number) => void
): { pixelData: Uint8ClampedArray; coreWidth: number; coreHeight: number } {
  const { width, height, samplesPerPixel, camera } = scene;

  const renderX = tileX - overlap.left;
  const renderY = tileY - overlap.top;
  const renderWidth = tileWidth + overlap.left + overlap.right;
  const renderHeight = tileHeight + overlap.top + overlap.bottom;

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
  const camDir = vec3Normalize(vec3Sub(camTarget, camPos));
  
  const worldUp: Vec3 = [0, 1, 0];
  const rightCross = [
    camDir[1] * worldUp[2] - camDir[2] * worldUp[1],
    camDir[2] * worldUp[0] - camDir[0] * worldUp[2],
    camDir[0] * worldUp[1] - camDir[1] * worldUp[0]
  ];
  const rightLen = Math.sqrt(rightCross[0]**2 + rightCross[1]**2 + rightCross[2]**2);
  const camRight: Vec3 = [rightCross[0] / rightLen, rightCross[1] / rightLen, rightCross[2] / rightLen];

  const camUp = [
    camRight[1] * camDir[2] - camRight[2] * camDir[1],
    camRight[2] * camDir[0] - camRight[0] * camDir[2],
    camRight[0] * camDir[1] - camRight[1] * camDir[0]
  ];

  let totalPixels = actualRenderWidth * actualRenderHeight;
  let pixelsRendered = 0;

  for (let py = 0; py < actualRenderHeight; py++) {
    for (let px = 0; px < actualRenderWidth; px++) {
      const globalPx = clampedRenderX + px;
      const globalPy = clampedRenderY + py;

      let color: Vec3 = [0, 0, 0];

      for (let s = 0; s < samplesPerPixel; s++) {
        const sampleSeed = hashPixelSeed(tileIndex, globalPx, globalPy, s);
        const rng = new SeededRNG(sampleSeed);

        const jitterX = rng.next();
        const jitterY = rng.next();

        const u = ((globalPx + jitterX) / width) * 2 - 1;
        const v = 1 - ((globalPy + jitterY) / height) * 2;

        const rayDir = vec3Normalize([
          camDir[0] + camRight[0] * u * viewportWidth / 2 + camUp[0] * v * viewportHeight / 2,
          camDir[1] + camRight[1] * u * viewportWidth / 2 + camUp[1] * v * viewportHeight / 2,
          camDir[2] + camRight[2] * u * viewportWidth / 2 + camUp[2] * v * viewportHeight / 2
        ]);

        const sampleColor = traceRay(scene, camPos, rayDir, 5, rng);
        color[0] += sampleColor[0];
        color[1] += sampleColor[1];
        color[2] += sampleColor[2];
      }

      color = vec3Mul(color, 1 / samplesPerPixel);

      const r = Math.floor(clamp(Math.pow(color[0], 0.45), 0, 1) * 255);
      const g = Math.floor(clamp(Math.pow(color[1], 0.45), 0, 1) * 255);
      const b = Math.floor(clamp(Math.pow(color[2], 0.45), 0, 1) * 255);

      const idx = (py * actualRenderWidth + px) * 4;
      pixelData[idx] = r;
      pixelData[idx + 1] = g;
      pixelData[idx + 2] = b;
      pixelData[idx + 3] = 255;

      pixelsRendered++;
      if (onProgress && pixelsRendered % 100 === 0) {
        onProgress(pixelsRendered / totalPixels);
      }
    }
  }

  onProgress?.(1);

  return {
    pixelData,
    coreWidth: actualRenderWidth,
    coreHeight: actualRenderHeight
  };
}

export function blendOverlapTile(
  finalImageData: ImageData,
  tileResult: {
    x: number;
    y: number;
    width: number;
    height: number;
    overlap: TileOverlap;
    pixelData: Uint8ClampedArray;
    coreWidth: number;
    coreHeight: number;
  }
): void {
  const { x, y, width, height, overlap, pixelData, coreWidth, coreHeight } = tileResult;

  const overlapSize = overlap.left;

  for (let py = 0; py < coreHeight; py++) {
    const globalY = y - overlap.top + py;
    if (globalY < 0 || globalY >= finalImageData.height) continue;

    for (let px = 0; px < coreWidth; px++) {
      const globalX = x - overlap.left + px;
      if (globalX < 0 || globalX >= finalImageData.width) continue;

      const srcIdx = (py * coreWidth + px) * 4;
      const dstIdx = (globalY * finalImageData.width + globalX) * 4;

      const relX = globalX - x;
      const relY = globalY - y;

      let weight = 1.0;

      if (overlapSize > 0) {
        const leftOverlap = overlapSize - relX;
        const rightOverlap = relX - (width - 1 - overlapSize);
        const topOverlap = overlapSize - relY;
        const bottomOverlap = relY - (height - 1 - overlapSize);

        const xWeight = Math.min(
          leftOverlap > 0 ? leftOverlap / overlapSize : 1,
          rightOverlap > 0 ? 1 - rightOverlap / overlapSize : 1
        );
        const yWeight = Math.min(
          topOverlap > 0 ? topOverlap / overlapSize : 1,
          bottomOverlap > 0 ? 1 - bottomOverlap / overlapSize : 1
        );

        weight = Math.max(0, Math.min(1, xWeight * yWeight));
      }

      const existingR = finalImageData.data[dstIdx];
      const existingG = finalImageData.data[dstIdx + 1];
      const existingB = finalImageData.data[dstIdx + 2];
      const existingA = finalImageData.data[dstIdx + 3];

      if (existingA === 0) {
        finalImageData.data[dstIdx] = pixelData[srcIdx];
        finalImageData.data[dstIdx + 1] = pixelData[srcIdx + 1];
        finalImageData.data[dstIdx + 2] = pixelData[srcIdx + 2];
        finalImageData.data[dstIdx + 3] = 255;
      } else {
        const invWeight = 1 - weight;
        finalImageData.data[dstIdx] = Math.round(
          pixelData[srcIdx] * weight + existingR * invWeight
        );
        finalImageData.data[dstIdx + 1] = Math.round(
          pixelData[srcIdx + 1] * weight + existingG * invWeight
        );
        finalImageData.data[dstIdx + 2] = Math.round(
          pixelData[srcIdx + 2] * weight + existingB * invWeight
        );
        finalImageData.data[dstIdx + 3] = 255;
      }
    }
  }
}

export function createDefaultScene(): SceneData {
  return {
    width: 800,
    height: 600,
    samplesPerPixel: 100,
    camera: {
      position: [0, 2, 5],
      target: [0, 0, 0],
      fov: 60
    },
    spheres: [
      {
        center: [0, 0.5, 0],
        radius: 0.5,
        material: {
          color: [0.8, 0.3, 0.3],
          type: 'diffuse'
        }
      },
      {
        center: [-1.2, 0.3, 0],
        radius: 0.3,
        material: {
          color: [0.9, 0.9, 0.9],
          type: 'metal',
          roughness: 0.1
        }
      },
      {
        center: [1.2, 0.35, 0.2],
        radius: 0.35,
        material: {
          color: [0.3, 0.5, 0.9],
          type: 'diffuse'
        }
      },
      {
        center: [0.5, -0.3, -0.8],
        radius: 0.2,
        material: {
          color: [1, 1, 0.8],
          type: 'emissive',
          emission: [2, 2, 1.5]
        }
      }
    ],
    planes: [
      {
        point: [0, -0.5, 0],
        normal: [0, 1, 0],
        material: {
          color: [0.6, 0.6, 0.6],
          type: 'diffuse'
        }
      }
    ]
  };
}
