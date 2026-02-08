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
    const [buildProgress, setBuildProgress] = useState(0);
    const [modelDimensions, setModelDimensions] = useState<{
        width: number;
        height: number;
        depth: number;
    } | null>(null);
    const { cameraRef, controlsRef, modelGroupRef, materialRef, requestRender } = useThreeScene(
        mountRef,
        setIsBuilding
    );

    const progressRef = useRef(0);
    const progressLastUpdateRef = useRef(0);
    const pushProgress = (value: number) => {
        progressRef.current = value;
        const now = performance.now();
        if (value >= 1 || now - progressLastUpdateRef.current > 60) {
            progressLastUpdateRef.current = now;
            setBuildProgress(value);
        }
    };

    useEffect(() => {
        if (controlsRef.current) {
            controlsRef.current.enabled = !isBuilding;
        }
    }, [controlsRef, isBuilding]);

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
            pushProgress(0);

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

            // Build multi-mesh geometry (one object per color layer)
            const buildPixelGeometry = async (
                img: HTMLImageElement,
                bbox: { minX: number; minY: number; boxW: number; boxH: number }
            ) => {
                const nearestSwatchIndex = buildNearestSwatchFinder(swatches);
                if (token !== buildTokenRef.current) return;
                const fullW = img.naturalWidth;
                const fullH = img.naturalHeight;
                const { minX, minY, boxW, boxH } = bbox;
                const totalUnitsBase = Math.max(1, colorOrder.length * boxH);
                const totalUnits = autoPaintEnabled
                    ? Math.max(1, totalUnitsBase + boxH)
                    : totalUnitsBase;

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
                        pushProgress((py - minY + 1) / totalUnits);
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

                            pushProgress((boxH + i * boxH + (y + 1)) / totalUnits);

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

                    const layerIndexBySwatch = new Int32Array(swatches.length);
                    layerIndexBySwatch.fill(-1);
                    colorOrder.forEach((swatchIdx, pos) => {
                        if (swatchIdx >= 0 && swatchIdx < layerIndexBySwatch.length) {
                            layerIndexBySwatch[swatchIdx] = pos;
                        }
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
                                        const layerPos = layerIndexBySwatch[sIdx];
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
                            pushProgress((i * boxH + (y + 1)) / totalUnits);
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

                requestRender();
                pushProgress(1);
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
                const bbox = { minX, minY, boxW, boxH };

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
                        if (pixelColumns) await buildPixelGeometry(img, bbox);
                        res();
                    })
                );
                if (token === buildTokenRef.current) {
                    setIsBuilding(false);
                    pushProgress(1);
                }
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
        requestRender,
    ]);

    return (
        <div className="w-full h-full relative" ref={mountRef}>
            {isBuilding && (
                <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/80 backdrop-blur-sm">
                    <div className="w-[260px] rounded-xl border border-border/60 bg-background/90 shadow-lg px-4 py-3">
                        <div className="text-sm font-semibold text-foreground">
                            Generating mesh...
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                            {Math.round(buildProgress * 100)}%
                        </div>
                        <div className="mt-3 h-2 w-full rounded-full bg-muted">
                            <div
                                className="h-2 rounded-full bg-primary transition-[width] duration-150"
                                style={{ width: `${Math.round(buildProgress * 100)}%` }}
                            />
                        </div>
                    </div>
                </div>
            )}
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
