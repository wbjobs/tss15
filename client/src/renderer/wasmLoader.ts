let wasmModule: any = null;
let isLoading = false;
let loadPromise: Promise<any> | null = null;

export async function loadWasmModule(): Promise<any> {
  if (wasmModule) {
    return wasmModule;
  }

  if (isLoading && loadPromise) {
    return loadPromise;
  }

  isLoading = true;
  
  loadPromise = (async () => {
    try {
      const module = await import('/raytracer-wasm/raytracer_wasm.js');
      await module.default();
      wasmModule = module;
      console.log('WebAssembly module loaded successfully');
      return module;
    } catch (error) {
      console.warn('Failed to load WebAssembly module, falling back to JS renderer:', error);
      return null;
    }
  })();

  const result = await loadPromise;
  isLoading = false;
  return result;
}

export function isWasmAvailable(): boolean {
  return wasmModule !== null;
}

export function getWasmModule(): any {
  return wasmModule;
}
