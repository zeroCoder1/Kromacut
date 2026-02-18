/**
 * Hook that runs the auto-paint algorithm in a Web Worker.
 *
 * Replaces the previous synchronous `useMemo` approach, ensuring the
 * optimizer (exhaustive / SA / GA) never blocks the main thread.
 *
 * Features:
 * - Automatic cancellation: a new request obsoletes any in-flight one.
 * - Loading state for UI feedback.
 * - Lazy worker instantiation (created on first real request).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AutoPaintResult } from '../lib/autoPaint';
import type { Filament } from '../types';
import type {
    AutoPaintWorkerRequest,
    AutoPaintWorkerResponse,
} from '../workers/autoPaint.worker';

export interface UseAutoPaintWorkerOptions {
    paintMode: 'manual' | 'autopaint';
    filaments: Filament[];
    filtered: Array<{ hex: string; a: number } & Record<string, unknown>>;
    layerHeight: number;
    slicerFirstLayerHeight: number;
    autoPaintMaxHeight?: number;
    enhancedColorMatch: boolean;
    allowRepeatedSwaps: boolean;
    optimizerAlgorithm: 'exhaustive' | 'simulated-annealing' | 'genetic' | 'auto';
    optimizerSeed?: number;
    regionWeightingMode: 'uniform' | 'center' | 'edge';
    imageDimensions?: { width: number; height: number } | null;
}

export interface UseAutoPaintWorkerResult {
    autoPaintResult: AutoPaintResult | undefined;
    isComputing: boolean;
}

let nextRequestId = 1;

export function useAutoPaintWorker(
    opts: UseAutoPaintWorkerOptions
): UseAutoPaintWorkerResult {
    const {
        paintMode,
        filaments,
        filtered,
        layerHeight,
        slicerFirstLayerHeight,
        autoPaintMaxHeight,
        enhancedColorMatch,
        allowRepeatedSwaps,
        optimizerAlgorithm,
        optimizerSeed,
        regionWeightingMode,
        imageDimensions,
    } = opts;

    const [autoPaintResult, setAutoPaintResult] = useState<AutoPaintResult | undefined>(undefined);
    const [isComputing, setIsComputing] = useState(false);

    const workerRef = useRef<Worker | null>(null);
    const activeRequestIdRef = useRef<number>(0);

    // Create the worker lazily on first need.
    const getWorker = useCallback(() => {
        if (!workerRef.current) {
            workerRef.current = new Worker(
                new URL('../workers/autoPaint.worker.ts', import.meta.url),
                { type: 'module' }
            );
            workerRef.current.onmessage = (e: MessageEvent<AutoPaintWorkerResponse>) => {
                const resp = e.data;
                // Ignore stale responses from obsoleted requests.
                if (resp.id !== activeRequestIdRef.current) return;

                if (resp.error) {
                    console.error('[autoPaintWorker] error:', resp.error);
                } else {
                    setAutoPaintResult(resp.result);
                }
                setIsComputing(false);
            };
            workerRef.current.onerror = (err) => {
                console.error('[autoPaintWorker] worker error:', err);
                setIsComputing(false);
            };
        }
        return workerRef.current;
    }, []);

    // Terminate worker on unmount.
    useEffect(() => {
        return () => {
            workerRef.current?.terminate();
            workerRef.current = null;
        };
    }, []);

    // Dispatch computation whenever inputs change.
    useEffect(() => {
        // Not in autopaint mode — clear result.
        if (paintMode !== 'autopaint' || filaments.length === 0 || filtered.length === 0) {
            setAutoPaintResult(undefined);
            setIsComputing(false);
            return;
        }

        const id = nextRequestId++;
        activeRequestIdRef.current = id;
        setIsComputing(true);

        const worker = getWorker();

        const request: AutoPaintWorkerRequest = {
            id,
            filaments,
            imageSwatches: filtered.map((s) => ({
                hex: s.hex,
                count: s.count as number | undefined,
            })),
            layerHeight,
            firstLayerHeight: slicerFirstLayerHeight,
            maxHeight: autoPaintMaxHeight,
            enhancedColorMatch,
            allowRepeatedSwaps,
            optimizerOptions: {
                algorithm: optimizerAlgorithm,
                ...(optimizerSeed !== undefined && { seed: optimizerSeed }),
            },
            regionWeightingMode,
            imageDimensions: imageDimensions ?? undefined,
        };

        worker.postMessage(request);
    }, [
        paintMode,
        filaments,
        filtered,
        layerHeight,
        slicerFirstLayerHeight,
        autoPaintMaxHeight,
        enhancedColorMatch,
        allowRepeatedSwaps,
        optimizerAlgorithm,
        optimizerSeed,
        regionWeightingMode,
        imageDimensions,
        getWorker,
    ]);

    return { autoPaintResult, isComputing };
}
