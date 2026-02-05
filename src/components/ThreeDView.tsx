import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import useThreeScene from '../hooks/useThreeScene';
import { generateGreedyMesh } from '../lib/meshing';

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
    // Auto-paint mode props
    autoPaintEnabled?: boolean;
    autoPaintTotalHeight?: number; // Total model height when auto-paint is enabled
}

// Convert hex color to RGB tuple
function hexToRGB(hex: string): [number, number, number] {
    const h = hex.replace(/^#/, '');
    const r = parseInt(h.slice(0, 2), 16) || 0;
    const g = parseInt(h.slice(2, 4), 16) || 0;
    const b = parseInt(h.slice(4, 6), 16) || 0;
    return [r, g, b];
}

// Calculate perceived luminance (0-1 range)
function getLuminance(r: number, g: number, b: number): number {
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
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
    autoPaintEnabled = false,
    autoPaintTotalHeight,
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

                // Precompute cumulative heights (for standard mode)
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

                // For auto-paint mode, we need to find the luminance range of the image
                // to map pixel luminance to height
                let minLum = 1,
                    maxLum = 0;
                if (autoPaintEnabled && autoPaintTotalHeight) {
                    // First pass: find luminance range
                    for (let py = 0; py < bH; py++) {
                        for (let px = 0; px < bW; px++) {
                            const idx = (py * bW + px) * 4;
                            const a = data[idx + 3];
                            if (a > 0) {
                                const lum = getLuminance(data[idx], data[idx + 1], data[idx + 2]);
                                minLum = Math.min(minLum, lum);
                                maxLum = Math.max(maxLum, lum);
                            }
                        }
                    }
                    // Ensure we have a valid range
                    if (maxLum <= minLum) {
                        maxLum = minLum + 0.001;
                    }
                }

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

                    let height = 0;

                    if (opaque) {
                        if (autoPaintEnabled && autoPaintTotalHeight) {
                            // Auto-paint mode: map luminance to height
                            // Darker pixels = base layer height, lighter pixels = full height
                            const lum = getLuminance(r, g, bcol);
                            const normalizedLum = (lum - minLum) / (maxLum - minLum);

                            // Ensure darkest pixels still have at least the first layer
                            const firstLayerH = Math.max(slicerFirstLayerHeight, layerHeight);
                            height =
                                firstLayerH + normalizedLum * (autoPaintTotalHeight - firstLayerH);

                            // Snap to layer height grid
                            if (layerHeight > 0) {
                                const delta = Math.max(0, height - slicerFirstLayerHeight);
                                height =
                                    slicerFirstLayerHeight +
                                    Math.round(delta / layerHeight) * layerHeight;
                                height = Math.max(slicerFirstLayerHeight, height);
                            }
                        } else {
                            // Standard mode: use color-based heights
                            height = baseSliceHeight;
                            if (swatches.length) {
                                const swatchIndex = nearestSwatchIndex(r, g, bcol);
                                if (swatchIndex !== -1) {
                                    const orderPos = orderPositions.get(swatchIndex);
                                    if (orderPos !== undefined)
                                        height += cumulativePerOrderPos[orderPos] || 0;
                                }
                            }
                            if (layerHeight > 0) {
                                const delta = Math.max(0, height - slicerFirstLayerHeight);
                                height =
                                    slicerFirstLayerHeight +
                                    Math.round(delta / layerHeight) * layerHeight;
                            }
                        }
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
                } catch {
                    /* ignore */
                }

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

                // Clear current model
                modelGroup.clear();

                const YIELD_MS = 12;
                let lastYield = performance.now();

                if (autoPaintEnabled && autoPaintTotalHeight && autoPaintTotalHeight > 0) {
                    // === AUTO-PAINT MODE ===
                    // Build layers based on luminance ranges

                    // First, find the luminance range of the image
                    let minLum = 1,
                        maxLum = 0;
                    for (let py = minY; py < minY + boxH; py++) {
                        for (let px = minX; px < minX + boxW; px++) {
                            const idx = (py * fullW + px) * 4;
                            const a = data[idx + 3];
                            if (a > 0) {
                                const lum = getLuminance(data[idx], data[idx + 1], data[idx + 2]);
                                minLum = Math.min(minLum, lum);
                                maxLum = Math.max(maxLum, lum);
                            }
                        }
                    }
                    if (maxLum <= minLum) maxLum = minLum + 0.001;

                    // Build layers from the colorSliceHeights (which are now the auto-paint layers)
                    // Each layer has a color (from swatches) and a cumulative height
                    const cumulativeHeights: number[] = [];
                    let running = 0;
                    colorOrder.forEach((fi, pos) => {
                        const h = colorSliceHeights[fi] || 0;
                        const eff = pos === 0 ? Math.max(h, slicerFirstLayerHeight) : h;
                        running += eff;
                        cumulativeHeights[pos] = running;
                    });

                    // For each layer, find pixels whose target height falls within this layer
                    for (let i = 0; i < colorOrder.length; i++) {
                        if (token !== buildTokenRef.current) return;

                        const swatchIdx = colorOrder[i];
                        if (!swatches[swatchIdx]) continue;
                        const colorHex = swatches[swatchIdx].hex;
                        const thickness =
                            i === 0
                                ? Math.max(
                                      colorSliceHeights[swatchIdx] || 0,
                                      slicerFirstLayerHeight
                                  )
                                : colorSliceHeights[swatchIdx] || 0;
                        if (thickness <= 0.0001) continue;

                        const baseZ = i === 0 ? 0 : cumulativeHeights[i - 1];
                        const topZ = cumulativeHeights[i];

                        // Identify active pixels for this layer
                        // A pixel is active if its height extends THROUGH this entire layer
                        // (pixelHeight >= topZ means the pixel column reaches at least to the top of this layer)
                        const activePixels = new Uint8Array(boxW * boxH);
                        let activeCount = 0;

                        for (let y = 0; y < boxH; y++) {
                            for (let x = 0; x < boxW; x++) {
                                const px = minX + x;
                                const py = minY + y;
                                const idx = (py * fullW + px) * 4;
                                const a = data[idx + 3];

                                if (a > 0) {
                                    const lum = getLuminance(
                                        data[idx],
                                        data[idx + 1],
                                        data[idx + 2]
                                    );
                                    const normalizedLum = (lum - minLum) / (maxLum - minLum);

                                    // Map luminance to height:
                                    // - Darkest pixels get height = first layer (base only)
                                    // - Lightest pixels get height = autoPaintTotalHeight (all layers)
                                    const firstLayerH = Math.max(
                                        slicerFirstLayerHeight,
                                        colorSliceHeights[colorOrder[0]] || slicerFirstLayerHeight
                                    );
                                    let pixelHeight =
                                        firstLayerH +
                                        normalizedLum * (autoPaintTotalHeight - firstLayerH);

                                    // Snap to layer height grid
                                    if (layerHeight > 0) {
                                        const delta = Math.max(
                                            0,
                                            pixelHeight - slicerFirstLayerHeight
                                        );
                                        pixelHeight =
                                            slicerFirstLayerHeight +
                                            Math.round(delta / layerHeight) * layerHeight;
                                        pixelHeight = Math.max(slicerFirstLayerHeight, pixelHeight);
                                    }

                                    // Include this pixel if its height extends THROUGH this layer
                                    // pixelHeight >= topZ means the column reaches the top of this layer
                                    // This creates the graduated effect: higher layers have fewer pixels
                                    if (pixelHeight >= topZ - 0.001) {
                                        activePixels[(boxH - 1 - y) * boxW + x] = 1;
                                        activeCount++;
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

                        // Generate mesh for this layer
                        const { positions, indices } = generateGreedyMesh(
                            activePixels,
                            boxW,
                            boxH,
                            thickness,
                            baseZ,
                            pixelSize,
                            heightScale
                        );

                        const geom = new THREE.BufferGeometry();
                        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
                        geom.setIndex(indices);
                        geom.computeVertexNormals();

                        const mat = new THREE.MeshStandardMaterial({
                            color: colorHex,
                            roughness: 0.5,
                            metalness: 0.1,
                            side: THREE.DoubleSide,
                        });

                        const mesh = new THREE.Mesh(geom, mat);
                        modelGroup.add(mesh);

                        if (performance.now() - lastYield > YIELD_MS) {
                            await new Promise((r) => requestAnimationFrame(r));
                            if (token !== buildTokenRef.current) return;
                            lastYield = performance.now();
                        }
                    }
                } else {
                    // === STANDARD MODE ===
                    // Prepare layers
                    const cumulativeHeights: number[] = [];
                    let running = 0;
                    colorOrder.forEach((fi, pos) => {
                        const h = colorSliceHeights[fi] || 0;
                        const eff = pos === 0 ? Math.max(h, slicerFirstLayerHeight) : h;
                        running += eff;
                        cumulativeHeights[pos] = running;
                    });

                    // Iterate each color layer and build a mesh
                    for (let i = 0; i < colorOrder.length; i++) {
                        if (token !== buildTokenRef.current) return;

                        const swatchIdx = colorOrder[i];
                        if (!swatches[swatchIdx]) continue;
                        const colorHex = swatches[swatchIdx].hex;
                        const thickness =
                            i === 0
                                ? Math.max(
                                      colorSliceHeights[swatchIdx] || 0,
                                      slicerFirstLayerHeight
                                  )
                                : colorSliceHeights[swatchIdx] || 0;
                        if (thickness <= 0.0001) continue; // Skip empty layers

                        const baseZ = i === 0 ? 0 : cumulativeHeights[i - 1];

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
                                            // Flip Y axis: Image Y (0=top) -> Grid Y (0=bottom)
                                            // We want Image Top (0) to be at Grid High Y (boxH-1) => 3D High Y
                                            // So map y -> boxH - 1 - y
                                            activePixels[(boxH - 1 - y) * boxW + x] = 1;
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

                        // Generate Optimized Greedy Mesh
                        const { positions, indices } = generateGreedyMesh(
                            activePixels,
                            boxW,
                            boxH,
                            thickness,
                            baseZ,
                            pixelSize,
                            heightScale
                        );

                        const geom = new THREE.BufferGeometry();
                        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
                        geom.setIndex(indices);
                        geom.computeVertexNormals();

                        const mat = new THREE.MeshStandardMaterial({
                            color: colorHex,
                            roughness: 0.5,
                            metalness: 0.1,
                            side: THREE.DoubleSide,
                        });

                        // Note: generateGreedyMesh returns world-space coordinates (scaled by pixelSize/heightScale)
                        // so we do not need to apply scale/position to the mesh itself.
                        const mesh = new THREE.Mesh(geom, mat);

                        modelGroup.add(mesh);

                        if (performance.now() - lastYield > YIELD_MS) {
                            await new Promise((r) => requestAnimationFrame(r));
                            if (token !== buildTokenRef.current) return;
                            lastYield = performance.now();
                        }
                    }
                }

                if (token !== buildTokenRef.current) return;

                try {
                    (
                        window as unknown as { __KROMACUT_LAST_MESH?: THREE.Object3D }
                    ).__KROMACUT_LAST_MESH = modelGroup;
                } catch {
                    /* ignore */
                }

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
                        const camPos = sphere.center
                            .clone()
                            .add(dir.multiplyScalar(distance * 1.35));
                        camera.position.copy(camPos);
                        controls.target.copy(sphere.center);
                        camera.near = Math.max(0.01, sphere.radius * 0.01);
                        camera.far = sphere.radius * 20;
                        camera.updateProjectionMatrix();
                        controls.update();
                    }
                } catch {
                    /* ignore */
                }
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
                    minX = 0;
                    minY = 0;
                    maxX = w - 1;
                    maxY = h - 1;
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
        autoPaintEnabled,
        autoPaintTotalHeight,
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
