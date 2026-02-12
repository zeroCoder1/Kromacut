import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Swatch, ThreeDControlsStateShape } from '../types';
import { hexLuminance } from '../lib/colorUtils';

export interface UseColorSlicingOptions {
    swatches: Swatch[] | null;
    layerHeight: number;
    slicerFirstLayerHeight: number;
    persisted?: ThreeDControlsStateShape | null;
}

export function useColorSlicing({
    swatches,
    layerHeight,
    slicerFirstLayerHeight,
    persisted,
}: UseColorSlicingOptions) {
    // derive non-transparent swatches once per render and memoize
    const filtered = useMemo(() => {
        return swatches ? swatches.filter((s) => s.a !== 0) : [];
    }, [swatches]);

    const [colorSliceHeights, setColorSliceHeights] = useState<number[]>(
        persisted?.colorSliceHeights?.slice() ?? []
    );

    // ordering state: indices into `filtered` that control displayed order.
    const [colorOrder, setColorOrder] = useState<number[]>(persisted?.colorOrder?.slice() ?? []);
    const prevFilteredRef = useRef<Swatch[] | null>(
        persisted?.filteredSwatches ? persisted.filteredSwatches.slice() : null
    );
    const prevHeightsRef = useRef<number[]>(
        persisted?.colorSliceHeights ? persisted.colorSliceHeights.slice() : []
    );
    const prevOrderRef = useRef<number[]>(
        persisted?.colorOrder ? persisted.colorOrder.slice() : []
    );

    // guard so we only emit immediately after hydration if needed
    const hydratedRef = useRef<boolean>(false);
    useEffect(() => {
        if (persisted && !hydratedRef.current) {
            hydratedRef.current = true;
        }
    }, [persisted]);

    // Initialize or resize per-color slice heights and preserve ordering when swatches change.
    useEffect(() => {
        if (filtered.length === 0) return;

        const prevFiltered = prevFilteredRef.current || [];
        const prevHeights = prevHeightsRef.current || [];
        const prevOrder = prevOrderRef.current || [];

        // Map prior heights by (hex,a) signature for quick lookup.
        const heightMap = new Map<string, number>();
        for (let i = 0; i < prevFiltered.length; i++) {
            const pf = prevFiltered[i];
            const key = pf.hex + ':' + pf.a;
            const prevHeight = prevHeights[i];
            if (typeof prevHeight === 'number' && isFinite(prevHeight) && prevHeight >= 0) {
                heightMap.set(key, prevHeight);
            }
        }

        const nextHeights = filtered.map((s) => {
            const key = s.hex + ':' + s.a;
            const existing = heightMap.get(key);
            const isValid = typeof existing === 'number' && isFinite(existing) && existing >= 0;
            const base = isValid ? existing : layerHeight;
            const clamped = Math.max(layerHeight, Math.min(10, base));
            if (!layerHeight || !isFinite(layerHeight) || layerHeight <= 0) {
                return isValid ? base : 0.2;
            }
            const multiple = Math.round(clamped / layerHeight) * layerHeight;
            const snapped = Math.max(layerHeight, Math.min(10, multiple));
            return Number(snapped.toFixed(8));
        });
        setColorSliceHeights(nextHeights);

        // Reconstruct order using previous colorOrder mapping if available.
        const nextOrder: number[] = [];
        if (prevOrder.length && prevFiltered.length) {
            for (const prevIdx of prevOrder) {
                const sw = prevFiltered[prevIdx];
                if (!sw) continue;
                const idx = filtered.findIndex((f) => f.hex === sw.hex && f.a === sw.a);
                if (idx !== -1 && !nextOrder.includes(idx)) nextOrder.push(idx);
            }
        }
        // Fallback / append any remaining colors not yet in order.
        const remaining: number[] = [];
        for (let i = 0; i < filtered.length; i++) {
            if (!nextOrder.includes(i)) remaining.push(i);
        }
        remaining.sort((a, b) => hexLuminance(filtered[a].hex) - hexLuminance(filtered[b].hex));
        nextOrder.push(...remaining);
        setColorOrder(nextOrder);

        prevFilteredRef.current = filtered.slice();
        prevHeightsRef.current = nextHeights.slice();
        prevOrderRef.current = nextOrder.slice();
    }, [filtered, layerHeight]);

    const displayOrder = useMemo(() => {
        return colorOrder.length === filtered.length ? colorOrder : filtered.map((_, i) => i);
    }, [colorOrder, filtered]);

    const onRowChange = useCallback((idx: number, v: number) => {
        setColorSliceHeights((prev) => {
            const next = prev.slice();
            next[idx] = v;
            return next;
        });
    }, []);

    const handleResetHeights = useCallback(() => {
        if (filtered.length === 0) return;

        const indices = filtered.map((_, i) => i);
        indices.sort((a, b) => hexLuminance(filtered[a].hex) - hexLuminance(filtered[b].hex));

        const nextHeights = [...colorSliceHeights];
        indices.forEach((fi, idx) => {
            if (idx === 0) {
                nextHeights[fi] = Math.max(layerHeight, slicerFirstLayerHeight);
            } else {
                nextHeights[fi] = layerHeight;
            }
        });

        setColorOrder(indices);
        setColorSliceHeights(nextHeights);
    }, [filtered, colorSliceHeights, layerHeight, slicerFirstLayerHeight]);

    const handleColorOrderChange = useCallback((newOrder: string[]) => {
        const newColorOrder = newOrder.map((v) => Number(v));
        setColorOrder(newColorOrder);
        prevOrderRef.current = newColorOrder.slice();
    }, []);

    // Ensure the currently-first color in display order cannot be below the slicer first layer height
    // AND all colors stay aligned with valid layer boundaries.
    useEffect(() => {
        if (displayOrder.length === 0) return;

        let changed = false;
        const next = colorSliceHeights.slice();

        displayOrder.forEach((fi, idx) => {
            const current = next[fi];
            if (typeof current !== 'number' || !isFinite(current)) return;

            let snapped: number;
            if (idx === 0) {
                const minFirst = Math.max(layerHeight, slicerFirstLayerHeight);
                const delta = Math.max(0, current - minFirst);
                snapped = minFirst + Math.round(delta / layerHeight) * layerHeight;
            } else {
                snapped = Math.round(current / layerHeight) * layerHeight;
                snapped = Math.max(layerHeight, snapped);
            }

            snapped = Number(snapped.toFixed(8));
            if (Math.abs(current - snapped) > 1e-6) {
                next[fi] = snapped;
                changed = true;
            }
        });

        if (changed) {
            setColorSliceHeights(next);
        }
    }, [displayOrder, colorSliceHeights, layerHeight, slicerFirstLayerHeight]);

    // Check if the current state already matches what reset would produce
    const isResetState = useMemo(() => {
        if (filtered.length === 0) return true;
        // compute the luminance-sorted order
        const lumOrder = filtered.map((_, i) => i);
        lumOrder.sort((a, b) => hexLuminance(filtered[a].hex) - hexLuminance(filtered[b].hex));
        // compare order
        if (displayOrder.length !== lumOrder.length) return false;
        for (let i = 0; i < lumOrder.length; i++) {
            if (displayOrder[i] !== lumOrder[i]) return false;
        }
        // compare heights
        for (let idx = 0; idx < lumOrder.length; idx++) {
            const fi = lumOrder[idx];
            const expected = idx === 0 ? Math.max(layerHeight, slicerFirstLayerHeight) : layerHeight;
            const actual = colorSliceHeights[fi] ?? layerHeight;
            if (Math.abs(actual - expected) > 1e-6) return false;
        }
        return true;
    }, [filtered, displayOrder, colorSliceHeights, layerHeight, slicerFirstLayerHeight]);

    return {
        filtered,
        colorSliceHeights,
        colorOrder,
        displayOrder,
        onRowChange,
        handleResetHeights,
        handleColorOrderChange,
        isResetState,
    };
}
