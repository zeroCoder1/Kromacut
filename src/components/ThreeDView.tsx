import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import useThreeScene from '../hooks/useThreeScene';

interface ThreeDViewProps {
    imageSrc?: string | null;
    baseSliceHeight: number; // mm
    layerHeight: number; // mm (granularity)
    slicerFirstLayerHeight?: number; // mm
    colorSliceHeights: number[]; // per color height increments (mm)
    colorOrder: number[]; // ordering (indices into swatches)
    swatches: { hex: string; a: number }[]; // filtered (non-transparent) swatches in original order
    pixelSize?: number; // mm per pixel horizontally (X & Z). Default 0.01 => 100px = 1mm
    heightScale?: number; // vertical exaggeration (1 = real scale)
    stepped?: boolean; // if true, flatten each cell to a uniform height (square plateaus instead of spikes)
    pixelColumns?: boolean; // if true, final build uses one plateau per image pixel (rectangular towers)
    rebuildSignal?: number;
}

// Convert hex color to RGB tuple
function hexToRGB(hex: string): [number, number, number] {
    const h = hex.replace(/^#/, '');
    const r = parseInt(h.slice(0, 2), 16) || 0;
    const g = parseInt(h.slice(2, 4), 16) || 0;
    const b = parseInt(h.slice(4, 6), 16) || 0;
    return [r, g, b];
}

// Nearest-color match with small cache to avoid exact equality issues
function buildNearestSwatchFinder(swatches: { hex: string; a: number }[]) {
    const rgb = swatches.map((s) => hexToRGB(s.hex));
    const cache = new Map<number, number>(); // key = (r<<16)|(g<<8)|b -> swatch index
    return (r: number, g: number, b: number) => {
        const key = ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
        const cached = cache.get(key);
        if (cached !== undefined) return cached;
        let best = -1;
        let bestD = Infinity;
        for (let i = 0; i < rgb.length; i++) {
            const [sr, sg, sb] = rgb[i];
            const dr = sr - r;
            const dg = sg - g;
            const db = sb - b;
            const d = dr * dr + dg * dg + db * db;
            if (d < bestD) {
                bestD = d;
                best = i;
                if (d === 0) break; // exact match
            }
        }
        cache.set(key, best);
        return best;
    };
}

export default function ThreeDView({
    imageSrc,
    baseSliceHeight,
    layerHeight,
    slicerFirstLayerHeight = 0,
    colorSliceHeights,
    colorOrder,
    swatches,
    pixelSize = 0.01,
    heightScale = 1,
    stepped = false,
    pixelColumns = true,
    rebuildSignal = 0,
}: ThreeDViewProps) {
    const mountRef = useRef<HTMLDivElement | null>(null);
    const [isBuilding, setIsBuilding] = useState(false);
    const [modelDimensions, setModelDimensions] = useState<{
        width: number;
        height: number;
        depth: number;
    } | null>(null);
    const { cameraRef, controlsRef, modelGroupRef, materialRef } = useThreeScene(
        mountRef,
        setIsBuilding
    );

    // Sync overlay visibility when build state changes
    useEffect(() => {
        const el = mountRef.current;
        if (!el) return;
        const overlay = Array.from(el.children).find(
            (c) => c.nodeType === 1 && (c as HTMLElement).textContent === 'Building 3D model…'
        ) as HTMLElement | undefined;
        if (!overlay) return;
        overlay.style.display = isBuilding ? 'flex' : 'none';
    }, [isBuilding]);

    // 2. Rebuild mesh geometry whenever inputs change (debounced, progressive, adaptive resolution)
    const buildTokenRef = useRef(0);
    const debounceTimerRef = useRef<number | null>(null);
    const lastParamsKeyRef = useRef<string | null>(null);
    const lastRebuildRef = useRef<number>(rebuildSignal);

    useEffect(() => {
        const modelGroup = modelGroupRef.current;
        if (!modelGroup || !imageSrc) return;

        // If parent requested a rebuild via the rebuildSignal, clear the last params key
        // to force the effect to proceed even if params otherwise match.
        if (rebuildSignal !== lastRebuildRef.current) {
            lastParamsKeyRef.current = null;
            lastRebuildRef.current = rebuildSignal;
        }

        // Stable key of inputs to avoid duplicate builds when references unchanged
        const paramsKey = JSON.stringify({
            imageSrc,
            baseSliceHeight,
            layerHeight,
            colorSliceHeights,
            colorOrder,
            swatches: swatches.map((s) => s.hex),
            pixelSize,
            heightScale,
            stepped,
            pixelColumns,
        });
        if (paramsKey === lastParamsKeyRef.current) return; // nothing changed logically
        lastParamsKeyRef.current = paramsKey;

        // Debounce rapid changes (e.g., dragging slider)
        if (debounceTimerRef.current) window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = window.setTimeout(() => {
            const token = ++buildTokenRef.current;
            // mark that a build is in progress for the overlay
            setIsBuilding(true);

            const chooseResolution = (w: number, h: number) => {
                const maxDim = Math.max(w, h);
                if (maxDim > 3000) return 512;
                if (maxDim > 2000) return 384;
                if (maxDim > 1600) return 320;
                if (maxDim > 1200) return 256;
                if (maxDim > 900) return 192;
                if (maxDim > 600) return 160;
                if (maxDim > 400) return 128;
                return 96;
            };

            const requestIdle = (fn: () => void) => {
                const ric = (
                    window as unknown as {
                        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
                    }
                ).requestIdleCallback;
                if (typeof ric === 'function') ric(fn, { timeout: 300 });
                else setTimeout(fn, 0);
            };

            // Shared image load (do once for preview + final)
            const loadImage = () =>
                new Promise<HTMLImageElement | null>((res) => {
                    const i = new Image();
                    i.crossOrigin = 'anonymous';
                    i.onload = () => res(i);
                    i.onerror = () => res(null);
                    i.src = imageSrc;
                });

            const buildGeometry = async (
                img: HTMLImageElement,
                resolution: number,
                _mode: 'preview' | 'final',
                bbox?: {
                    minX: number;
                    minY: number;
                    boxW: number;
                    boxH: number;
                }
            ) => {
                const nearestSwatchIndex = buildNearestSwatchFinder(swatches);
                if (token !== buildTokenRef.current) return; // superseded
                const w = img.naturalWidth;
                const h = img.naturalHeight;
                if (!w || !h) return;

                // Prepare a cropped canvas of the opaque bounding box for consistent sampling
                const canvas = document.createElement('canvas');
                const bMinX = bbox ? bbox.minX : 0;
                const bMinY = bbox ? bbox.minY : 0;
                const bW = bbox ? bbox.boxW : w;
                const bH = bbox ? bbox.boxH : h;
                canvas.width = bW;
                canvas.height = bH;
                const ctx = canvas.getContext('2d');
                if (!ctx) return;
                ctx.drawImage(img, bMinX, bMinY, bW, bH, 0, 0, bW, bH);
                const { data } = ctx.getImageData(0, 0, bW, bH);

                // For preview mode, we stick to the single-mesh terrain approach for performance
                // Create a canvas-based texture for crisp sampling
                try {
                    const tex = new THREE.CanvasTexture(canvas);
                    tex.magFilter = THREE.NearestFilter;
                    tex.minFilter = THREE.NearestFilter;
                    tex.generateMipmaps = false;
                    tex.wrapS = THREE.ClampToEdgeWrapping;
                    tex.wrapT = THREE.ClampToEdgeWrapping;
                    tex.colorSpace = THREE.SRGBColorSpace;
                    tex.repeat.set(1, 1);
                    tex.offset.set(0, 0);
                    tex.needsUpdate = true;
                    const mat = materialRef.current;
                    if (mat) {
                        mat.map = tex;
                        mat.alphaMap = tex;
                        mat.vertexColors = false;
                        mat.flatShading = true;
                        mat.needsUpdate = true;
                    }
                } catch {
                    /* ignore texture assign failure */
                }

                // Precompute cumulative heights
                const orderPositions = new Map<number, number>();
                colorOrder.forEach((fi, pos) => orderPositions.set(fi, pos));
                const cumulativePerOrderPos: number[] = [];
                let running = 0;
                colorOrder.forEach((fi, pos) => {
                    const h = colorSliceHeights[fi] || 0;
                    const eff = pos === 0 ? Math.max(h, slicerFirstLayerHeight) : h;
                    running += eff;
                    cumulativePerOrderPos[pos] = running;
                });

                // Create indexed plane geometry (grid)
                const indexedPlane = new THREE.PlaneGeometry(1, 1, resolution, resolution);
                const idxPos = indexedPlane.getAttribute('position');
                const indexedVertexCount = idxPos.count;
                const uvIdx = indexedPlane.getAttribute('uv') as THREE.BufferAttribute | null;
                const YIELD_EVERY_MS = 12;
                let lastYield = performance.now();

                // Compute heights on the indexed grid vertices
                for (let vi = 0; vi < indexedVertexCount; vi++) {
                    const u = uvIdx ? uvIdx.getX(vi) : idxPos.getX(vi) + 0.5;
                    const v = uvIdx ? uvIdx.getY(vi) : idxPos.getY(vi) + 0.5;
                    const px = Math.min(bW - 1, Math.max(0, Math.round(u * (bW - 1))));
                    const py = Math.min(bH - 1, Math.max(0, Math.round((1 - v) * (bH - 1))));
                    const idx = (py * bW + px) * 4;
                    const r = data[idx];
                    const g = data[idx + 1];
                    const bcol = data[idx + 2];
                    const a = data[idx + 3];
                    const opaque = a > 0;
                    let height = opaque ? baseSliceHeight : 0;
                    if (opaque && swatches.length) {
                        const swatchIndex = nearestSwatchIndex(r, g, bcol);
                        if (swatchIndex !== -1) {
                            const orderPos = orderPositions.get(swatchIndex);
                            if (orderPos !== undefined)
                                height += cumulativePerOrderPos[orderPos] || 0;
                        }
                    }
                    if (opaque && layerHeight > 0) {
                        const delta = Math.max(0, height - slicerFirstLayerHeight);
                        height =
                            slicerFirstLayerHeight + Math.round(delta / layerHeight) * layerHeight;
                    }
                    idxPos.setZ(vi, height);

                    if (performance.now() - lastYield > YIELD_EVERY_MS) {
                        await new Promise((r) => requestAnimationFrame(r));
                        if (token !== buildTokenRef.current) return;
                        lastYield = performance.now();
                    }
                }

                if (token !== buildTokenRef.current) {
                    indexedPlane.dispose();
                    return;
                }

                // For preview, we just use the non-indexed terrain
                const finalGeom = indexedPlane.toNonIndexed();
                finalGeom.computeVertexNormals();
                indexedPlane.dispose();

                // Clear model group and add new mesh
                modelGroup.clear();
                // Dispose old materials if they were separate (preview uses shared materialRef)
                
                const mesh = new THREE.Mesh(finalGeom, materialRef.current || undefined);
                const finalW = bbox ? bbox.boxW : w;
                const finalH = bbox ? bbox.boxH : h;
                mesh.scale.set(finalW * pixelSize, finalH * pixelSize, heightScale);
                modelGroup.add(mesh);

                try {
                    (
                        window as unknown as { __KROMACUT_LAST_MESH?: THREE.Object3D }
                    ).__KROMACUT_LAST_MESH = modelGroup;
                } catch { /* ignore */ }

                // Calculate maximum height (depth) of the model
                const box = new THREE.Box3().setFromObject(modelGroup);
                const maxDepth = box.max.z - box.min.z;
                setModelDimensions({
                    width: finalW * pixelSize,
                    height: finalH * pixelSize,
                    depth: maxDepth,
                });
            };

            // Build multi-mesh geometry (one object per color layer)
            const buildPixelGeometry = async (
                img: HTMLImageElement,
                mode: 'preview' | 'final',
                bbox: { minX: number; minY: number; boxW: number; boxH: number }
            ) => {
                const nearestSwatchIndex = buildNearestSwatchFinder(swatches);
                if (token !== buildTokenRef.current) return;
                const fullW = img.naturalWidth;
                const fullH = img.naturalHeight;
                const { minX, minY, boxW, boxH } = bbox;
                
                // Safety guard for enormous images
                if (boxW * boxH > 1_200_000) {
                    console.warn('[3D] pixelColumns fallback to adaptive (image too large)');
                    return buildGeometry(img, chooseResolution(boxW, boxH), mode, bbox);
                }

                const canvas = document.createElement('canvas');
                canvas.width = fullW;
                canvas.height = fullH;
                const ctx = canvas.getContext('2d');
                if (!ctx) return;
                ctx.drawImage(img, 0, 0, fullW, fullH);
                const { data } = ctx.getImageData(0, 0, fullW, fullH);

                // Prepare layers
                const cumulativeHeights: number[] = [];
                let running = 0;
                colorOrder.forEach((fi, pos) => {
                    const h = colorSliceHeights[fi] || 0;
                    const eff = pos === 0 ? Math.max(h, slicerFirstLayerHeight) : h;
                    running += eff;
                    cumulativeHeights[pos] = running;
                });

                // Clear current model
                modelGroup.clear();

                const YIELD_MS = 12;
                let lastYield = performance.now();

                // Iterate each color layer and build a mesh
                for (let i = 0; i < colorOrder.length; i++) {
                    if (token !== buildTokenRef.current) return;
                    
                    const swatchIdx = colorOrder[i];
                    if (!swatches[swatchIdx]) continue;
                    const colorHex = swatches[swatchIdx].hex;
                    const thickness = (i === 0 ? Math.max(colorSliceHeights[swatchIdx] || 0, slicerFirstLayerHeight) : (colorSliceHeights[swatchIdx] || 0));
                    if (thickness <= 0.0001) continue; // Skip empty layers
                    
                    const baseZ = (i === 0 ? 0 : cumulativeHeights[i - 1]);
                    
                    // Identify active pixels for this layer
                    // Pixel is active if its color index maps to a layer >= i
                    const activePixels = new Uint8Array(boxW * boxH);
                    let activeCount = 0;

                    for (let y = 0; y < boxH; y++) {
                        for (let x = 0; x < boxW; x++) {
                            const px = minX + x;
                            const py = minY + y;
                            const idx = (py * fullW + px) * 4;
                            const r = data[idx];
                            const g = data[idx + 1];
                            const b = data[idx + 2];
                            const a = data[idx + 3];
                            
                            if (a > 0) {
                                const sIdx = nearestSwatchIndex(r, g, b);
                                if (sIdx !== -1) {
                                    // Find which layer this swatch belongs to
                                    // We need to know if the swatch's layer position >= i
                                    // swatches are mapped to order by colorOrder array
                                    // colorOrder[pos] = sIdx
                                    // so we find pos where colorOrder[pos] == sIdx
                                    const layerPos = colorOrder.indexOf(sIdx);
                                    if (layerPos >= i) {
                                        activePixels[y * boxW + x] = 1;
                                        activeCount++;
                                    }
                                }
                            }
                        }
                         if (performance.now() - lastYield > YIELD_MS) {
                            await new Promise((r) => requestAnimationFrame(r));
                            if (token !== buildTokenRef.current) return;
                            lastYield = performance.now();
                        }
                    }

                    if (activeCount === 0) continue;

                    // Generate geometry for this layer
                    // We reuse the wall-building logic from before
                    const widthSegments = boxW;
                    const heightSegments = boxH;
                    const vertsRow = widthSegments + 1;
                    
                    // Generate vertices
                    // Each vertex height is either thickness (if owning pixel is active) or 0
                    // Actually, we want to generate a solid mesh for the active region.
                    // Vertices for the grid:
                    // A vertex (vx, vy) is shared by 4 pixels. 
                    // To get crisp walls, we usually duplicate vertices or use logic where 
                    // vertex height is max of adjacent active pixels.
                    // For "minecraft" style blocks, we need 4 verts per pixel?
                    // Or shared verts where adjacent pixels are both active.
                    // The previous logic used shared verts and handled walls at boundaries.
                    // We will stick to shared verts grid (vertsRow * (heightSegments+1)).
                    // Vertex is "high" (thickness) if any adjacent pixel is active?
                    // No, that dilates the shape.
                    // Previously: cellHeights[x,y] = height.
                    // Vertex Z = max of 4 adjacent cells.
                    // If we have an isolated active pixel, its 4 corners become high.
                    // This forms a plateau.
                    // If we have an isolated inactive pixel surrounded by active, its corners are high?
                    // Yes, so the hole is closed? No.
                    // Let's re-verify the "max of adjacent" logic.
                    // If (x,y) is active (H=T). Neighbors inactive (H=0).
                    // Verts at (x,y), (x+1,y), (x,y+1), (x+1,y+1) will all see T as max.
                    // So the quad for pixel (x,y) is at height T.
                    // The quads for neighbors are at height T (at the shared edge) and 0 (at outer edge).
                    // This creates a slope.
                    // BUT we used `flatShading` and logic to separate top/bottom/walls.
                    // The previous logic: 
                    // 1. Set Z for all verts based on cell heights (max).
                    // 2. Identify opaque cells.
                    // 3. Create Top Faces for opaque cells (using the Zs).
                    // 4. Create Bottom Faces.
                    // 5. Create Walls between opaque and non-opaque.
                    // This works perfectly for a "layer slab".
                    // The "slope" happens if we used the shared verts for everything.
                    // But we separate faces. Top face uses the high verts.
                    // Does a neighbor (inactive) pixel use the high verts? 
                    // If neighbor is inactive, we don't generate top/bottom faces for it.
                    // So the slope geometry is never generated as a top face.
                    // The wall is generated at the boundary.
                    // So this logic holds.
                    
                    const numVerts = (widthSegments + 1) * (heightSegments + 1);
                    const topZs = new Float32Array(numVerts);
                    
                    for (let vy = 0; vy <= heightSegments; vy++) {
                         for (let vx = 0; vx <= widthSegments; vx++) {
                             let isActiveVert = false;
                             // Check 4 neighbors
                             const check = (cx: number, cy: number) => {
                                 if (cx >= 0 && cy >= 0 && cx < widthSegments && cy < heightSegments) {
                                     if (activePixels[cy * widthSegments + cx]) isActiveVert = true;
                                 }
                             };
                             check(vx - 1, vy - 1);
                             check(vx - 1, vy);
                             check(vx, vy - 1);
                             check(vx, vy);
                             topZs[vy * vertsRow + vx] = isActiveVert ? thickness : 0;
                         }
                    }

                    // Build buffers
                    const topIndices: number[] = [];
                    const bottomIndices: number[] = [];
                    
                    for (let y = 0; y < heightSegments; y++) {
                        for (let x = 0; x < widthSegments; x++) {
                            if (!activePixels[y * widthSegments + x]) continue;
                            const a = y * vertsRow + x;
                            const b = a + 1;
                            const c = a + vertsRow;
                            const d = c + 1;
                            // Top faces (CCW: a, b, c and b, d, c)
                            topIndices.push(a, b, c, b, d, c);
                            // Bottom faces (CW: a, c, b and b, c, d)
                            bottomIndices.push(a, c, b, b, c, d);
                        }
                    }

                    // Walls
                    const wallIndices: number[] = [];
                    const numV = numVerts; // convenient alias

                    // Helper to push a quad (2 triangles)
                    // v0, v1, v2, v3 in CCW order
                    const pushQuad = (v0: number, v1: number, v2: number, v3: number) => {
                        wallIndices.push(v0, v1, v2);
                        wallIndices.push(v0, v2, v3);
                    };
                    
                    for (let x = 0; x <= widthSegments; x++) {
                        for (let y = 0; y < heightSegments; y++) {
                             const l = (x > 0) ? activePixels[y * widthSegments + x - 1] : 0;
                             const r = (x < widthSegments) ? activePixels[y * widthSegments + x] : 0;
                             
                             if (!!l !== !!r) {
                                 // Vertical segment at x, from y to y+1
                                 const tA = y * vertsRow + x;       // Top, y
                                 const tB = (y + 1) * vertsRow + x; // Top, y+1
                                 const bA = tA + numV;              // Bottom, y
                                 const bB = tB + numV;              // Bottom, y+1
                                 
                                 if (l) {
                                     // Right Wall of l (Normal +X)
                                     // Winding: bA, bB, tB, tA
                                     pushQuad(bA, bB, tB, tA);
                                 } else {
                                     // Left Wall of r (Normal -X)
                                     // Winding: bB, bA, tA, tB
                                     pushQuad(bB, bA, tA, tB);
                                 }
                             }
                        }
                    }
                    for (let y = 0; y <= heightSegments; y++) {
                        for (let x = 0; x < widthSegments; x++) {
                             const t = (y > 0) ? activePixels[(y - 1) * widthSegments + x] : 0;
                             const b = (y < heightSegments) ? activePixels[y * widthSegments + x] : 0;
                             
                             if (!!t !== !!b) {
                                 // Horizontal segment at y, from x to x+1
                                 const tA = y * vertsRow + x;       // Top, x
                                 const tB = y * vertsRow + (x + 1); // Top, x+1
                                 const bA = tA + numV;              // Bottom, x
                                 const bB = tB + numV;              // Bottom, x+1
                                 
                                 if (t) {
                                     // Bottom Wall of t (Normal +Y)
                                     // Winding: bB, bA, tA, tB
                                     pushQuad(bB, bA, tA, tB);
                                 } else {
                                     // Top Wall of b (Normal -Y)
                                     // Winding: bA, bB, tB, tA
                                     pushQuad(bA, bB, tB, tA);
                                 }
                             }
                        }
                    }

                    // Construct final geometry
                    const positions = new Float32Array(numVerts * 2 * 3);
                    
                    for (let i = 0; i < numVerts; i++) {
                        const vx = i % vertsRow;
                        const vy = Math.floor(i / vertsRow);
                        // Top
                        positions[i * 3 + 0] = vx;
                        positions[i * 3 + 1] = vy;
                        positions[i * 3 + 2] = topZs[i]; // thickness or 0
                        // Bottom
                        const bi = i + numVerts;
                        positions[bi * 3 + 0] = vx;
                        positions[bi * 3 + 1] = vy;
                        positions[bi * 3 + 2] = 0; // base of this layer slab is local 0
                    }

                    // Indices
                    const finalIndices: number[] = [];
                    // Top faces
                    for (let k = 0; k < topIndices.length; k++) {
                        finalIndices.push(topIndices[k]);
                    }
                    // Bottom faces (offset by numVerts)
                    for (let k = 0; k < bottomIndices.length; k++) {
                        finalIndices.push(bottomIndices[k] + numVerts);
                    }
                    // Walls
                    for (let k = 0; k < wallIndices.length; k++) {
                        finalIndices.push(wallIndices[k]);
                    }

                    const geom = new THREE.BufferGeometry();
                    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
                    geom.setIndex(finalIndices);
                    // No UVs needed for solid color? Or maybe for debug. 
                    // No vertex colors needed, we use material color.
                    geom.computeVertexNormals();
                    
                    const mat = new THREE.MeshStandardMaterial({
                        color: colorHex,
                        roughness: 0.5,
                        metalness: 0.1,
                        side: THREE.DoubleSide 
                    });
                    
                    const mesh = new THREE.Mesh(geom, mat);
                    mesh.scale.set(pixelSize, pixelSize, heightScale);
                    mesh.position.z = baseZ * heightScale;
                    
                    // Center the group? No, we didn't center before.
                    
                    modelGroup.add(mesh);
                    
                    if (performance.now() - lastYield > YIELD_MS) {
                        await new Promise((r) => requestAnimationFrame(r));
                        if (token !== buildTokenRef.current) return;
                        lastYield = performance.now();
                    }
                }

                if (token !== buildTokenRef.current) return;

                try {
                    (
                        window as unknown as { __KROMACUT_LAST_MESH?: THREE.Object3D }
                    ).__KROMACUT_LAST_MESH = modelGroup;
                } catch { /* ignore */ }

                // Calculate dimensions
                const box = new THREE.Box3().setFromObject(modelGroup);
                const maxDepth = box.max.z - box.min.z;
                const finalW = boxW;
                const finalH = boxH;
                setModelDimensions({
                    width: finalW * pixelSize,
                    height: finalH * pixelSize,
                    depth: maxDepth,
                });
                
                // Auto-frame
                try {
                    const camera = cameraRef.current;
                    const controls = controlsRef.current;
                    if (camera && controls) {
                        const sphere = new THREE.Sphere();
                        box.getBoundingSphere(sphere);
                         // ... same framing logic ...
                        const fov = (camera.fov * Math.PI) / 180;
                        const distance = sphere.radius / Math.sin(fov / 2);
                        const dir = new THREE.Vector3(0.9, 0.8, 1).normalize();
                        const camPos = sphere.center.clone().add(dir.multiplyScalar(distance * 1.35));
                        camera.position.copy(camPos);
                        controls.target.copy(sphere.center);
                        camera.near = Math.max(0.01, sphere.radius * 0.01);
                        camera.far = sphere.radius * 20;
                        camera.updateProjectionMatrix();
                        controls.update();
                    }
                } catch { /* ignore */ }
            };

            (async () => {
                const img = await loadImage();
                if (!img || token !== buildTokenRef.current) return;
                const w = img.naturalWidth;
                const h = img.naturalHeight;
                // compute opaque bounding box
                const c = document.createElement('canvas');
                c.width = w;
                c.height = h;
                const cx = c.getContext('2d');
                if (!cx) return;
                cx.drawImage(img, 0, 0, w, h);
                const imgd = cx.getImageData(0, 0, w, h).data;
                let minX = w,
                    minY = h,
                    maxX = 0,
                    maxY = 0;
                for (let y = 0; y < h; y++) {
                    for (let x = 0; x < w; x++) {
                        const a = imgd[(y * w + x) * 4 + 3];
                        if (a > 0) {
                            if (x < minX) minX = x;
                            if (y < minY) minY = y;
                            if (x > maxX) maxX = x;
                            if (y > maxY) maxY = y;
                        }
                    }
                }
                if (maxX < minX || maxY < minY) {
                    minX = 0; minY = 0; maxX = w - 1; maxY = h - 1;
                }
                const boxW = maxX - minX + 1;
                const boxH = maxY - minY + 1;
                const fullRes = chooseResolution(boxW, boxH);
                const previewRes = Math.max(32, Math.round(fullRes / 3));
                const bbox = { minX, minY, boxW, boxH };
                
                // Always use preview build first
                await buildGeometry(img, previewRes, 'preview', bbox);
                
                if (token !== buildTokenRef.current) {
                    setIsBuilding(false);
                    return;
                }
                
                // Schedule final build
                await new Promise<void>((res) =>
                    requestIdle(async () => {
                        if (token !== buildTokenRef.current) {
                            res();
                            return;
                        }
                        if (pixelColumns) await buildPixelGeometry(img, 'final', bbox);
                        else await buildGeometry(img, fullRes, 'final', bbox);
                        res();
                    })
                );
                if (token === buildTokenRef.current) setIsBuilding(false);
            })();
        }, 120);

        return () => {
            if (debounceTimerRef.current) window.clearTimeout(debounceTimerRef.current);
        };
    }, [
        imageSrc,
        baseSliceHeight,
        layerHeight,
        slicerFirstLayerHeight,
        colorSliceHeights,
        colorOrder,
        swatches,
        pixelSize,
        heightScale,
        stepped,
        pixelColumns,
        rebuildSignal,
        cameraRef,
        controlsRef,
        materialRef,
        modelGroupRef,
    ]);

    return (
        <div className="w-full h-full relative" ref={mountRef}>
            {modelDimensions && (
                <div
                    className="absolute top-2 left-2 px-2 py-1 rounded-full bg-primary/10 text-primary text-xs font-mono font-semibold z-10"
                    aria-hidden
                >
                    Model: {modelDimensions.width.toFixed(1)}×{modelDimensions.height.toFixed(1)}×
                    {modelDimensions.depth.toFixed(1)} mm
                </div>
            )}
        </div>
    );
}