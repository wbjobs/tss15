import type { SceneData, Sphere, Plane, Material, Camera } from '../types';

export function parseGLTF(gltfData: any): SceneData {
  const spheres: Sphere[] = [];
  const planes: Plane[] = [];
  let camera: Camera = {
    position: [0, 2, 5],
    target: [0, 0, 0],
    fov: 60
  };

  if (gltfData.cameras && gltfData.cameras.length > 0) {
    const cam = gltfData.cameras[0];
    if (cam.perspective) {
      camera.fov = (cam.perspective.yfov * 180) / Math.PI;
    }
  }

  if (gltfData.nodes) {
    for (const node of gltfData.nodes) {
      const translation = node.translation || [0, 0, 0];
      
      if (node.camera !== undefined) {
        camera.position = translation;
        
        if (node.rotation) {
          const target = quaternionToDirection(node.rotation);
          camera.target = [
            camera.position[0] + target[0],
            camera.position[1] + target[1],
            camera.position[2] + target[2]
          ];
        }
      }

      if (node.mesh !== undefined && gltfData.meshes) {
        const mesh = gltfData.meshes[node.mesh];
        if (mesh.primitives) {
          for (const primitive of mesh.primitives) {
            if (isSpherePrimitive(primitive, gltfData)) {
              const sphere = parseSpherePrimitive(primitive, gltfData, translation);
              spheres.push(sphere);
            } else if (isPlanePrimitive(primitive, gltfData)) {
              const plane = parsePlanePrimitive(primitive, gltfData, translation);
              planes.push(plane);
            }
          }
        }
      }

      if (node.extensions && node.extensions.KHR_materials_variants) {
      }
    }
  }

  if (spheres.length === 0 && planes.length === 0) {
    return createDefaultScene();
  }

  return {
    width: 800,
    height: 600,
    samplesPerPixel: 100,
    camera,
    spheres,
    planes
  };
}

function isSpherePrimitive(primitive: any, gltfData: any): boolean {
  if (primitive.attributes && primitive.attributes.POSITION !== undefined) {
    const positions = getAccessorData(gltfData, primitive.attributes.POSITION);
    if (positions && positions.length >= 3) {
      const firstVertex = [positions[0], positions[1], positions[2]] as [number, number, number];
      const center = [0, 0, 0];
      const radius = distance(firstVertex, center);
      
      if (radius > 0 && isCloseToSphere(positions, center, radius)) {
        return true;
      }
    }
  }
  return false;
}

function isPlanePrimitive(primitive: any, gltfData: any): boolean {
  if (primitive.attributes && primitive.attributes.POSITION !== undefined) {
    const positions = getAccessorData(gltfData, primitive.attributes.POSITION);
    if (positions && positions.length >= 12) {
      const vertices = [];
      for (let i = 0; i < 4; i++) {
        vertices.push([positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]);
      }
      
      if (isCoplanar(vertices)) {
        return true;
      }
    }
  }
  return false;
}

function parseSpherePrimitive(primitive: any, gltfData: any, translation: number[]): Sphere {
  const positions = getAccessorData(gltfData, primitive.attributes.POSITION) || [];
  
  let center = [...translation] as [number, number, number];
  let radius = 0.5;

  if (positions.length >= 3) {
    const firstVertex = [positions[0], positions[1], positions[2]];
    radius = distance(firstVertex as [number, number, number], [0, 0, 0]);
  }

  const material = parseMaterial(primitive, gltfData);

  return {
    center,
    radius,
    material
  };
}

function parsePlanePrimitive(primitive: any, gltfData: any, translation: number[]): Plane {
  const positions = getAccessorData(gltfData, primitive.attributes.POSITION) || [];
  
  let point = [...translation] as [number, number, number];
  let normal: [number, number, number] = [0, 1, 0];

  if (positions.length >= 9) {
    const v0 = [positions[0], positions[1], positions[2]];
    const v1 = [positions[3], positions[4], positions[5]];
    const v2 = [positions[6], positions[7], positions[8]];
    
    normal = computeNormal(v0, v1, v2);
  }

  const material = parseMaterial(primitive, gltfData);

  return {
    point,
    normal,
    material
  };
}

function parseMaterial(primitive: any, gltfData: any): Material {
  let material: Material = {
    color: [0.8, 0.8, 0.8],
    type: 'diffuse'
  };

  if (primitive.material !== undefined && gltfData.materials) {
    const mat = gltfData.materials[primitive.material];
    
    if (mat.pbrMetallicRoughness) {
      const baseColor = mat.pbrMetallicRoughness.baseColorFactor || [0.8, 0.8, 0.8, 1];
      material.color = [baseColor[0], baseColor[1], baseColor[2]];
      
      const metallic = mat.pbrMetallicRoughness.metallicFactor ?? 0;
      const roughness = mat.pbrMetallicRoughness.roughnessFactor ?? 0.5;
      
      if (metallic > 0.5) {
        material.type = 'metal';
        material.roughness = roughness;
      }
    }

    if (mat.emissiveFactor) {
      const emission = mat.emissiveFactor;
      if (emission[0] > 0 || emission[1] > 0 || emission[2] > 0) {
        material.type = 'emissive';
        material.emission = [emission[0], emission[1], emission[2]];
      }
    }

    if (mat.name) {
      if (mat.name.toLowerCase().includes('light') || mat.name.toLowerCase().includes('emit')) {
        material.type = 'emissive';
        if (!material.emission) {
          material.emission = [2, 2, 2];
        }
      }
      if (mat.name.toLowerCase().includes('metal')) {
        material.type = 'metal';
      }
    }
  }

  return material;
}

function getAccessorData(gltfData: any, accessorIndex: number): Float32Array | null {
  if (!gltfData.accessors || !gltfData.bufferViews || !gltfData.buffers) {
    return null;
  }

  const accessor = gltfData.accessors[accessorIndex];
  if (!accessor) return null;

  const bufferView = gltfData.bufferViews[accessor.bufferView];
  if (!bufferView) return null;

  return null;
}

function distance(a: [number, number, number], b: [number, number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function isCloseToSphere(positions: Float32Array | number[], center: number[], radius: number): boolean {
  for (let i = 0; i < Math.min(positions.length / 3, 20); i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const dist = distance([x, y, z], [center[0], center[1], center[2]]);
    if (Math.abs(dist - radius) > radius * 0.1) {
      return false;
    }
  }
  return true;
}

function isCoplanar(vertices: number[][]): boolean {
  if (vertices.length < 3) return false;
  
  const normal = computeNormal(vertices[0], vertices[1], vertices[2]);
  
  for (let i = 3; i < vertices.length; i++) {
    const v = vertices[i];
    const d = v[0] * normal[0] + v[1] * normal[1] + v[2] * normal[2];
    const d0 = vertices[0][0] * normal[0] + vertices[0][1] * normal[1] + vertices[0][2] * normal[2];
    if (Math.abs(d - d0) > 0.001) {
      return false;
    }
  }
  return true;
}

function computeNormal(v0: number[], v1: number[], v2: number[]): [number, number, number] {
  const e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
  const e2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
  
  const nx = e1[1] * e2[2] - e1[2] * e2[1];
  const ny = e1[2] * e2[0] - e1[0] * e2[2];
  const nz = e1[0] * e2[1] - e1[1] * e2[0];
  
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len === 0) return [0, 1, 0];
  
  return [nx / len, ny / len, nz / len];
}

function quaternionToDirection(quat: number[]): [number, number, number] {
  const [x, y, z, w] = quat;
  
  const dx = 2 * (x * z + w * y);
  const dy = 2 * (y * z - w * x);
  const dz = 1 - 2 * (x * x + y * y);
  
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len === 0) return [0, 0, -1];
  
  return [dx / len, dy / len, dz / len];
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

export async function loadGLTFFile(file: File): Promise<SceneData> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const gltfData = JSON.parse(content);
        const scene = parseGLTF(gltfData);
        resolve(scene);
      } catch (error) {
        console.warn('Failed to parse GLTF, using default scene:', error);
        resolve(createDefaultScene());
      }
    };
    
    reader.onerror = () => {
      reject(new Error('Failed to read file'));
    };
    
    reader.readAsText(file);
  });
}
