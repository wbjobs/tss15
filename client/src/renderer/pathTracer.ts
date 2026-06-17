import type { SceneData, Sphere, Plane, Material } from '../types';

type Vec3 = [number, number, number];

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

function randomUnitVector(): Vec3 {
  let x, y, z;
  do {
    x = Math.random() * 2 - 1;
    y = Math.random() * 2 - 1;
    z = Math.random() * 2 - 1;
  } while (x * x + y * y + z * z > 1 || x * x + y * y + z * z < 0.01);
  return vec3Normalize([x, y, z]);
}

function randomInHemisphere(normal: Vec3): Vec3 {
  const rand = randomUnitVector();
  if (vec3Dot(rand, normal) < 0) {
    return vec3Negate(rand);
  }
  return rand;
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
  depth: number
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
    scattered = vec3Normalize(vec3Add(reflected, vec3Mul(randomUnitVector(), fuzz)));
    if (vec3Dot(scattered, normal) < 0) {
      return [0, 0, 0];
    }
  } else {
    scattered = vec3Normalize(vec3Add(normal, randomUnitVector()));
  }

  const incoming = traceRay(scene, point, scattered, depth - 1);
  return vec3MulVec(attenuation, incoming);
}

export function renderTile(
  scene: SceneData,
  tileX: number,
  tileY: number,
  tileWidth: number,
  tileHeight: number,
  onProgress?: (progress: number) => void
): Uint8ClampedArray {
  const { width, height, samplesPerPixel, camera } = scene;
  const pixelData = new Uint8ClampedArray(tileWidth * tileHeight * 4);

  const aspectRatio = width / height;
  const fovRad = (camera.fov * Math.PI) / 180;
  const viewportHeight = 2 * Math.tan(fovRad / 2);
  const viewportWidth = viewportHeight * aspectRatio;

  const camPos = camera.position;
  const camTarget = camera.target;
  const camDir = vec3Normalize(vec3Sub(camTarget, camPos));
  
  const worldUp: Vec3 = [0, 1, 0];
  const camRight = vec3Normalize([0, 0, 0]);
  const rightCross = [
    camDir[1] * worldUp[2] - camDir[2] * worldUp[1],
    camDir[2] * worldUp[0] - camDir[0] * worldUp[2],
    camDir[0] * worldUp[1] - camDir[1] * worldUp[0]
  ];
  const rightLen = Math.sqrt(rightCross[0]**2 + rightCross[1]**2 + rightCross[2]**2);
  camRight[0] = rightCross[0] / rightLen;
  camRight[1] = rightCross[1] / rightLen;
  camRight[2] = rightCross[2] / rightLen;

  const camUp = [
    camRight[1] * camDir[2] - camRight[2] * camDir[1],
    camRight[2] * camDir[0] - camRight[0] * camDir[2],
    camRight[0] * camDir[1] - camRight[1] * camDir[0]
  ];

  const focalLength = 1;

  let totalPixels = tileWidth * tileHeight;
  let pixelsRendered = 0;

  for (let py = 0; py < tileHeight; py++) {
    for (let px = 0; px < tileWidth; px++) {
      let color: Vec3 = [0, 0, 0];

      for (let s = 0; s < samplesPerPixel; s++) {
        const u = ((tileX + px + Math.random()) / width) * 2 - 1;
        const v = 1 - ((tileY + py + Math.random()) / height) * 2;

        const rayDir = vec3Normalize([
          camDir[0] + camRight[0] * u * viewportWidth / 2 + camUp[0] * v * viewportHeight / 2,
          camDir[1] + camRight[1] * u * viewportWidth / 2 + camUp[1] * v * viewportHeight / 2,
          camDir[2] + camRight[2] * u * viewportWidth / 2 + camUp[2] * v * viewportHeight / 2
        ]);

        const sampleColor = traceRay(scene, camPos, rayDir, 5);
        color[0] += sampleColor[0];
        color[1] += sampleColor[1];
        color[2] += sampleColor[2];
      }

      color = vec3Mul(color, 1 / samplesPerPixel);

      const r = Math.floor(clamp(Math.pow(color[0], 0.45), 0, 1) * 255);
      const g = Math.floor(clamp(Math.pow(color[1], 0.45), 0, 1) * 255);
      const b = Math.floor(clamp(Math.pow(color[2], 0.45), 0, 1) * 255);

      const idx = (py * tileWidth + px) * 4;
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
  return pixelData;
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
