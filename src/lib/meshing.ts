export interface MeshData {
    positions: Float32Array;
    indices: number[];
}

/**
 * Generates an optimized 3D mesh for a layer of voxel-like pixels using Maximal Rectangle Greedy Meshing.
 * This approach minimizes the triangle count by merging active regions into large rectangles.
 *
 * T-Junction Prevention: Walls are generated in a separate global pass to ensure all wall
 * vertices align properly, preventing non-manifold edges that cause slicer artifacts.
 *
 * Coordinate system: X+ right, Y+ down (image coords), Z+ up
 * All faces use CCW winding when viewed from outside (right-hand rule for outward normals)
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

    // Add a quad with CCW winding (v0 -> v1 -> v2 -> v3 should be CCW when viewed from outside)
    const addQuadCCW = (v0: number, v1: number, v2: number, v3: number) => {
        // Two triangles: (v0, v1, v2) and (v0, v2, v3)
        indices.push(v0, v1, v2);
        indices.push(v0, v2, v3);
    };

    // --- Collect all greedy rectangles first ---
    interface Rect {
        x: number;
        y: number;
        w: number;
        h: number;
    }
    const rectangles: Rect[] = [];
    const visited = new Uint8Array(width * height);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;
            if (activePixels[idx] && !visited[idx]) {
                // 1. Find max width
                let w = 1;
                while (
                    x + w < width &&
                    activePixels[y * width + (x + w)] &&
                    !visited[y * width + (x + w)]
                ) {
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

                rectangles.push({ x, y, w, h });
            }
        }
    }

    // --- Build global vertex requirement sets for walls ---
    // These track all x-coordinates needed at each y for horizontal edges
    // and all y-coordinates needed at each x for vertical edges
    // This ensures walls are subdivided at T-junction points

    // For north/south walls: verticesAtY[y] = Set of x-coordinates where vertices exist
    const verticesAtY = new Map<number, Set<number>>();
    // For west/east walls: verticesAtX[x] = Set of y-coordinates where vertices exist
    const verticesAtX = new Map<number, Set<number>>();

    // First pass: collect all rectangle corner vertices
    for (const rect of rectangles) {
        const { x, y, w, h } = rect;

        // Add vertices at all four corners for each y-coordinate
        for (const yCoord of [y, y + h]) {
            if (!verticesAtY.has(yCoord)) verticesAtY.set(yCoord, new Set());
            verticesAtY.get(yCoord)!.add(x);
            verticesAtY.get(yCoord)!.add(x + w);
        }

        // Add vertices at all four corners for each x-coordinate
        for (const xCoord of [x, x + w]) {
            if (!verticesAtX.has(xCoord)) verticesAtX.set(xCoord, new Set());
            verticesAtX.get(xCoord)!.add(y);
            verticesAtX.get(xCoord)!.add(y + h);
        }
    }

    // --- Generate Top and Bottom Faces for each rectangle ---
    
    // Pre-sort vertices for fast range queries
    const sortedVerticesAtY = new Map<number, number[]>();
    for (const [y, set] of verticesAtY) {
        sortedVerticesAtY.set(y, Array.from(set).sort((a, b) => a - b));
    }
    const sortedVerticesAtX = new Map<number, number[]>();
    for (const [x, set] of verticesAtX) {
        sortedVerticesAtX.set(x, Array.from(set).sort((a, b) => a - b));
    }

    for (const rect of rectangles) {
        const { x, y, w, h } = rect;

        // Collect all boundary vertices in CCW order
        // We filter the global vertex lines to find points lying on our edges
        
        // Top edge: y, x -> x+w
        const topX = sortedVerticesAtY.get(y)!.filter(v => v >= x && v <= x + w);
        // Right edge: x+w, y -> y+h
        const rightY = sortedVerticesAtX.get(x + w)!.filter(v => v >= y && v <= y + h);
        // Bottom edge: y+h, x+w -> x (Reverse for CCW)
        const bottomX = sortedVerticesAtY.get(y + h)!.filter(v => v >= x && v <= x + w).reverse();
        // Left edge: x, y+h -> y (Reverse for CCW)
        const leftY = sortedVerticesAtX.get(x)!.filter(v => v >= y && v <= y + h).reverse();

        // Build the loop indices
        // We exclude the last point of each segment as it's the start of the next
        const buildLoop = (isTop: boolean) => {
            const loop: number[] = [];
            
            // Top Edge (x to x+w)
            for (let i = 0; i < topX.length - 1; i++) {
                loop.push(getOrAddVertex(topX[i], y, isTop));
            }
            // Right Edge (y to y+h)
            for (let i = 0; i < rightY.length - 1; i++) {
                loop.push(getOrAddVertex(x + w, rightY[i], isTop));
            }
            // Bottom Edge (x+w to x)
            for (let i = 0; i < bottomX.length - 1; i++) {
                loop.push(getOrAddVertex(bottomX[i], y + h, isTop));
            }
            // Left Edge (y+h to y)
            for (let i = 0; i < leftY.length - 1; i++) {
                loop.push(getOrAddVertex(x, leftY[i], isTop));
            }
            return loop;
        };

        const topLoop = buildLoop(true);
        const bottomLoop = buildLoop(false);

        // Triangulate (Fan from first vertex) - Shape is convex
        // Top Face (Normal +Z, CCW)
        const t0 = topLoop[0];
        for (let i = 1; i < topLoop.length - 1; i++) {
            indices.push(t0, topLoop[i], topLoop[i + 1]);
        }

        // Bottom Face (Normal -Z, need CW winding viewed from outside)
        // We use the same CCW loop but push indices as (v0, v2, v1)
        const b0 = bottomLoop[0];
        for (let i = 1; i < bottomLoop.length - 1; i++) {
            indices.push(b0, bottomLoop[i + 1], bottomLoop[i]);
        }
    }

    // --- Global Wall Generation ---
    // Collect all wall segments at pixel granularity, then merge respecting all vertices

    // North walls (facing -Y): edges at y where pixel[y] is active but pixel[y-1] is not
    // Map: y -> sorted list of x-coordinates needing north walls
    const northWalls = new Map<number, number[]>();
    // South walls (facing +Y): edges at y where pixel[y-1] is active but pixel[y] is not
    const southWalls = new Map<number, number[]>();
    // West walls (facing -X): edges at x where pixel[x] is active but pixel[x-1] is not
    const westWalls = new Map<number, number[]>();
    // East walls (facing +X): edges at x where pixel[x-1] is active but pixel[x] is not
    const eastWalls = new Map<number, number[]>();

    // Scan for all wall edges
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (!activePixels[y * width + x]) continue;

            // North wall needed if no neighbor above
            if (y === 0 || !activePixels[(y - 1) * width + x]) {
                if (!northWalls.has(y)) northWalls.set(y, []);
                northWalls.get(y)!.push(x);
            }

            // South wall needed if no neighbor below
            if (y === height - 1 || !activePixels[(y + 1) * width + x]) {
                const wallY = y + 1;
                if (!southWalls.has(wallY)) southWalls.set(wallY, []);
                southWalls.get(wallY)!.push(x);
            }

            // West wall needed if no neighbor to the left
            if (x === 0 || !activePixels[y * width + (x - 1)]) {
                if (!westWalls.has(x)) westWalls.set(x, []);
                westWalls.get(x)!.push(y);
            }

            // East wall needed if no neighbor to the right
            if (x === width - 1 || !activePixels[y * width + (x + 1)]) {
                const wallX = x + 1;
                if (!eastWalls.has(wallX)) eastWalls.set(wallX, []);
                eastWalls.get(wallX)!.push(y);
            }
        }
    }

    // Helper: merge wall segments respecting vertex positions
    const mergeAndEmitHorizontalWalls = (
        wallMap: Map<number, number[]>,
        yCoord: number,
        isSouth: boolean
    ) => {
        const xCoords = wallMap.get(yCoord);
        if (!xCoords || xCoords.length === 0) return;

        xCoords.sort((a, b) => a - b);

        // Get all x-coordinates where we must have vertices at this y
        const requiredVertices = verticesAtY.get(yCoord) || new Set<number>();

        let runStart = xCoords[0];
        let runEnd = runStart + 1;

        for (let i = 1; i <= xCoords.length; i++) {
            const nextX = i < xCoords.length ? xCoords[i] : -1;
            const isContiguous = nextX === runEnd;
            const mustSplit = requiredVertices.has(runEnd) && isContiguous;

            if (!isContiguous || mustSplit || i === xCoords.length) {
                // Emit wall segment from runStart to runEnd
                if (isSouth) {
                    // South wall (facing +Y)
                    const wTL = getOrAddVertex(runStart, yCoord, true);
                    const wTR = getOrAddVertex(runEnd, yCoord, true);
                    const wBR = getOrAddVertex(runEnd, yCoord, false);
                    const wBL = getOrAddVertex(runStart, yCoord, false);
                    addQuadCCW(wBL, wTL, wTR, wBR);
                } else {
                    // North wall (facing -Y)
                    const wTL = getOrAddVertex(runStart, yCoord, true);
                    const wTR = getOrAddVertex(runEnd, yCoord, true);
                    const wBR = getOrAddVertex(runEnd, yCoord, false);
                    const wBL = getOrAddVertex(runStart, yCoord, false);
                    addQuadCCW(wBR, wTR, wTL, wBL);
                }

                if (mustSplit && isContiguous) {
                    // Continue from the split point
                    runStart = runEnd;
                    runEnd = runStart + 1;
                } else if (i < xCoords.length) {
                    runStart = nextX;
                    runEnd = runStart + 1;
                }
            } else {
                runEnd = nextX + 1;
            }
        }
    };

    const mergeAndEmitVerticalWalls = (
        wallMap: Map<number, number[]>,
        xCoord: number,
        isEast: boolean
    ) => {
        const yCoords = wallMap.get(xCoord);
        if (!yCoords || yCoords.length === 0) return;

        yCoords.sort((a, b) => a - b);

        // Get all y-coordinates where we must have vertices at this x
        const requiredVertices = verticesAtX.get(xCoord) || new Set<number>();

        let runStart = yCoords[0];
        let runEnd = runStart + 1;

        for (let i = 1; i <= yCoords.length; i++) {
            const nextY = i < yCoords.length ? yCoords[i] : -1;
            const isContiguous = nextY === runEnd;
            const mustSplit = requiredVertices.has(runEnd) && isContiguous;

            if (!isContiguous || mustSplit || i === yCoords.length) {
                // Emit wall segment from runStart to runEnd
                if (isEast) {
                    // East wall (facing +X)
                    const wTL = getOrAddVertex(xCoord, runStart, true);
                    const wTR = getOrAddVertex(xCoord, runEnd, true);
                    const wBR = getOrAddVertex(xCoord, runEnd, false);
                    const wBL = getOrAddVertex(xCoord, runStart, false);
                    addQuadCCW(wBR, wTR, wTL, wBL);
                } else {
                    // West wall (facing -X)
                    const wTL = getOrAddVertex(xCoord, runStart, true);
                    const wTR = getOrAddVertex(xCoord, runEnd, true);
                    const wBR = getOrAddVertex(xCoord, runEnd, false);
                    const wBL = getOrAddVertex(xCoord, runStart, false);
                    addQuadCCW(wBL, wTL, wTR, wBR);
                }

                if (mustSplit && isContiguous) {
                    // Continue from the split point
                    runStart = runEnd;
                    runEnd = runStart + 1;
                } else if (i < yCoords.length) {
                    runStart = nextY;
                    runEnd = runStart + 1;
                }
            } else {
                runEnd = nextY + 1;
            }
        }
    };

    // Emit all walls
    for (const [y] of northWalls) {
        mergeAndEmitHorizontalWalls(northWalls, y, false);
    }
    for (const [y] of southWalls) {
        mergeAndEmitHorizontalWalls(southWalls, y, true);
    }
    for (const [x] of westWalls) {
        mergeAndEmitVerticalWalls(westWalls, x, false);
    }
    for (const [x] of eastWalls) {
        mergeAndEmitVerticalWalls(eastWalls, x, true);
    }

    return {
        positions: new Float32Array(positions),
        indices: indices,
    };
}
