
export interface MeshData {
    positions: Float32Array;
    indices: number[];
}

/**
 * Generates an optimized 3D mesh for a layer of voxel-like pixels using Maximal Rectangle Greedy Meshing.
 * This approach minimizes the triangle count by merging active regions into large rectangles
 * and merging wall segments into the longest possible strips.
 * 
 * @param activePixels Row-major array where >0 indicates presence of a pixel
 * @param width Width of the pixel grid
 * @param height Height of the pixel grid
 * @param thickness Thickness of the layer (Z height)
 * @param zOffset Base Z height of the layer
 * @param pixelSize XY scaling factor (usually mm per pixel)
 * @param heightScale Z scaling factor
 */
export function generateGreedyMesh(
    activePixels: Uint8Array | Uint8ClampedArray | boolean[],
    width: number,
    height: number,
    thickness: number,
    zOffset: number,
    pixelSize: number,
    heightScale: number
): MeshData {
    const positions: number[] = [];
    const indices: number[] = [];
    let vertCount = 0;

    // Vertex welding maps: key = y * (width + 1) + x
    const topMap = new Map<number, number>();
    const bottomMap = new Map<number, number>();
    const stride = width + 1;

    const scaledThickness = thickness * heightScale;
    const scaledZOffset = zOffset * heightScale;
    const zBottom = scaledZOffset;
    const zTop = scaledZOffset + scaledThickness;

    // --- Helper: Vertex Welding ---
    const getOrAddVertex = (x: number, y: number, isTop: boolean): number => {
        const key = y * stride + x;
        const map = isTop ? topMap : bottomMap;
        let idx = map.get(key);
        if (idx !== undefined) return idx;

        idx = vertCount++;
        map.set(key, idx);
        positions.push(x * pixelSize, y * pixelSize, isTop ? zTop : zBottom);
        return idx;
    };

    const addQuadIndices = (v0: number, v1: number, v2: number, v3: number) => {
        indices.push(v0, v1, v2);
        indices.push(v0, v2, v3);
    };

    // --- Greedy Meshing ---
    const visited = new Uint8Array(width * height);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;
            if (activePixels[idx] && !visited[idx]) {
                // 1. Find max width
                let w = 1;
                while (x + w < width && activePixels[y * width + (x + w)] && !visited[y * width + (x + w)]) {
                    w++;
                }

                // 2. Find max height for this width
                let h = 1;
                let canExpand = true;
                while (y + h < height && canExpand) {
                    for (let k = 0; k < w; k++) {
                        const nextIdx = (y + h) * width + (x + k);
                        if (!activePixels[nextIdx] || visited[nextIdx]) {
                            canExpand = false;
                            break;
                        }
                    }
                    if (canExpand) h++;
                }

                // 3. Mark visited
                for (let dy = 0; dy < h; dy++) {
                    const rowOff = (y + dy) * width;
                    for (let dx = 0; dx < w; dx++) {
                        visited[rowOff + x + dx] = 1;
                    }
                }

                // 4. Generate Top and Bottom Faces
                // TL(x,y), TR(x+w, y), BR(x+w, y+h), BL(x, y+h)
                
                // Top (CCW)
                const tTL = getOrAddVertex(x, y, true);
                const tTR = getOrAddVertex(x + w, y, true);
                const tBR = getOrAddVertex(x + w, y + h, true);
                const tBL = getOrAddVertex(x, y + h, true);
                addQuadIndices(tTL, tTR, tBR, tBL);

                // Bottom (CW -> CCW from bottom)
                const bTL = getOrAddVertex(x, y, false);
                const bTR = getOrAddVertex(x + w, y, false);
                const bBR = getOrAddVertex(x + w, y + h, false);
                const bBL = getOrAddVertex(x, y + h, false);
                addQuadIndices(bTL, bBL, bBR, bTR);

                // 5. Generate Walls with Merging
                // We iterate along the perimeter and identify "runs" of inactive neighbors
                
                // North Edge (y) - Check neighbor at y-1
                // Iterate k from 0 to w.
                let runStart = -1;
                for (let k = 0; k < w; k++) {
                    const northActive = (y > 0) ? !!activePixels[(y - 1) * width + (x + k)] : false;
                    if (!northActive) {
                        if (runStart === -1) runStart = k;
                    } else {
                        if (runStart !== -1) {
                            // End of run, emit wall from runStart to k
                            // Wall from (x+runStart) to (x+k) at y
                            const vTR_ = getOrAddVertex(x + k, y, true);
                            const vTL_ = getOrAddVertex(x + runStart, y, true);
                            const vBL_ = getOrAddVertex(x + runStart, y, false);
                            const vBR_ = getOrAddVertex(x + k, y, false);
                            addQuadIndices(vTR_, vTL_, vBL_, vBR_);
                            runStart = -1;
                        }
                    }
                }
                if (runStart !== -1) {
                    // Emit remaining run
                    const vTR_ = getOrAddVertex(x + w, y, true);
                    const vTL_ = getOrAddVertex(x + runStart, y, true);
                    const vBL_ = getOrAddVertex(x + runStart, y, false);
                    const vBR_ = getOrAddVertex(x + w, y, false);
                    addQuadIndices(vTR_, vTL_, vBL_, vBR_);
                }

                // South Edge (y+h) - Check neighbor at y+h
                runStart = -1;
                for (let k = 0; k < w; k++) {
                    const southActive = (y + h < height) ? !!activePixels[(y + h) * width + (x + k)] : false;
                    if (!southActive) {
                        if (runStart === -1) runStart = k;
                    } else {
                        if (runStart !== -1) {
                            // Wall from (x+runStart) to (x+k) at y+h
                            // South Wall (+Y): TL->TR->BR->BL
                            const vTL_ = getOrAddVertex(x + runStart, y + h, true);
                            const vTR_ = getOrAddVertex(x + k, y + h, true);
                            const vBR_ = getOrAddVertex(x + k, y + h, false);
                            const vBL_ = getOrAddVertex(x + runStart, y + h, false);
                            addQuadIndices(vTL_, vTR_, vBR_, vBL_);
                            runStart = -1;
                        }
                    }
                }
                if (runStart !== -1) {
                    const vTL_ = getOrAddVertex(x + runStart, y + h, true);
                    const vTR_ = getOrAddVertex(x + w, y + h, true);
                    const vBR_ = getOrAddVertex(x + w, y + h, false);
                    const vBL_ = getOrAddVertex(x + runStart, y + h, false);
                    addQuadIndices(vTL_, vTR_, vBR_, vBL_);
                }

                // West Edge (x) - Check neighbor at x-1
                runStart = -1;
                for (let k = 0; k < h; k++) {
                    const westActive = (x > 0) ? !!activePixels[(y + k) * width + (x - 1)] : false;
                    if (!westActive) {
                        if (runStart === -1) runStart = k;
                    } else {
                        if (runStart !== -1) {
                            // Wall from y+runStart to y+k at x
                            // West Wall (-X): TL->TR->BR->BL (viewed from outside)
                            // (x, y+runStart, T) -> (x, y+k, T) -> (x, y+k, B) -> (x, y+runStart, B)
                            const vTL_ = getOrAddVertex(x, y + runStart, true);
                            const vTR_ = getOrAddVertex(x, y + k, true);
                            const vBR_ = getOrAddVertex(x, y + k, false);
                            const vBL_ = getOrAddVertex(x, y + runStart, false);
                            addQuadIndices(vTL_, vTR_, vBR_, vBL_);
                            runStart = -1;
                        }
                    }
                }
                if (runStart !== -1) {
                    const vTL_ = getOrAddVertex(x, y + runStart, true);
                    const vTR_ = getOrAddVertex(x, y + h, true);
                    const vBR_ = getOrAddVertex(x, y + h, false);
                    const vBL_ = getOrAddVertex(x, y + runStart, false);
                    addQuadIndices(vTL_, vTR_, vBR_, vBL_);
                }

                // East Edge (x+w) - Check neighbor at x+w
                runStart = -1;
                for (let k = 0; k < h; k++) {
                    const eastActive = (x + w < width) ? !!activePixels[(y + k) * width + (x + w)] : false;
                    if (!eastActive) {
                        if (runStart === -1) runStart = k;
                    } else {
                        if (runStart !== -1) {
                            // Wall from y+runStart to y+k at x+w
                            // East Wall (+X): TL->TR->BR->BL
                            // (x+w, y+k, T) -> (x+w, y+runStart, T) -> (x+w, y+runStart, B) -> (x+w, y+k, B)
                            const vTL_ = getOrAddVertex(x + w, y + k, true);
                            const vTR_ = getOrAddVertex(x + w, y + runStart, true);
                            const vBR_ = getOrAddVertex(x + w, y + runStart, false);
                            const vBL_ = getOrAddVertex(x + w, y + k, false);
                            addQuadIndices(vTL_, vTR_, vBR_, vBL_);
                            runStart = -1;
                        }
                    }
                }
                if (runStart !== -1) {
                    const vTL_ = getOrAddVertex(x + w, y + h, true);
                    const vTR_ = getOrAddVertex(x + w, y + runStart, true);
                    const vBR_ = getOrAddVertex(x + w, y + runStart, false);
                    const vBL_ = getOrAddVertex(x + w, y + h, false);
                    addQuadIndices(vTL_, vTR_, vBR_, vBL_);
                }
            }
        }
    }

    return {
        positions: new Float32Array(positions),
        indices: indices
    };
}
