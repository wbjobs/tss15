import type { Tile } from '../types';

export function generateTiles(
  width: number,
  height: number,
  tileSize: number
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

      tiles.push({
        id: `tile-${index}`,
        x,
        y,
        width: tileWidth,
        height: tileHeight,
        index
      });
      index++;
    }
  }

  return shuffleTiles(tiles);
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
