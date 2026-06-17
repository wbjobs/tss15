import type { Tile, TileOverlap } from '../types';

export function generateTiles(
  width: number,
  height: number,
  tileSize: number,
  overlapSize: number = 4
): Tile[] {
  const tiles: Tile[] = [];
  let index = 0;

  const cols = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = col * tileSize;
      const y = row * tileSize;
      const tileWidth = Math.min(tileSize, width - x);
      const tileHeight = Math.min(tileSize, height - y);

      const overlap: TileOverlap = {
        top: row > 0 ? overlapSize : 0,
        bottom: row < rows - 1 ? overlapSize : 0,
        left: col > 0 ? overlapSize : 0,
        right: col < cols - 1 ? overlapSize : 0
      };

      const seed = hashTileSeed(index, x, y);

      tiles.push({
        id: `tile-${index}`,
        x,
        y,
        width: tileWidth,
        height: tileHeight,
        index,
        overlap,
        seed
      });
      index++;
    }
  }

  return shuffleTiles(tiles);
}

function hashTileSeed(index: number, x: number, y: number): number {
  let h = index * 2654435761;
  h = (h + x * 340573321) | 0;
  h = (h + y * 2246822519) | 0;
  h = ((h ^ (h >> 16)) * 3266489917) | 0;
  return h >>> 0;
}

export function shuffleTiles(tiles: Tile[]): Tile[] {
  const shuffled = [...tiles];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function getTileGridSize(
  width: number,
  height: number,
  tileSize: number
): { cols: number; rows: number } {
  return {
    cols: Math.ceil(width / tileSize),
    rows: Math.ceil(height / tileSize)
  };
}
