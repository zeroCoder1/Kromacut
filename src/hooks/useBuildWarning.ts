import { useCallback, useEffect, useState } from 'react';
import type { ThreeDControlsStateShape } from '../types';

const LAYER_WARNING_THRESHOLD = 64;
const PIXEL_WARNING_THRESHOLD = 2500000;

export interface BuildWarning {
    warnings: string[];
    pendingState: ThreeDControlsStateShape;
}

export interface UseBuildWarningOptions {
    imageSrc?: string | null;
}

export function useBuildWarning({ imageSrc }: UseBuildWarningOptions) {
    const [imageDimensions, setImageDimensions] = useState<{ w: number; h: number } | null>(null);
    const [buildWarning, setBuildWarning] = useState<BuildWarning | null>(null);
    const [threeDState, setThreeDState] = useState<ThreeDControlsStateShape>({
        layerHeight: 0.12,
        slicerFirstLayerHeight: 0.2,
        colorSliceHeights: [],
        colorOrder: [],
        filteredSwatches: [],
        pixelSize: 0.1,
        filaments: [],
        paintMode: 'manual',
    });
    const [threeDBuildSignal, setThreeDBuildSignal] = useState(0);

    // Track image dimensions for build warning checks
    useEffect(() => {
        if (!imageSrc) {
            setImageDimensions(null);
            return;
        }
        const img = new Image();
        img.onload = () => setImageDimensions({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => setImageDimensions(null);
        img.src = imageSrc;
    }, [imageSrc]);

    // Apply state without warning (used after user confirms, or when no warning needed)
    const applyThreeDState = useCallback((s: ThreeDControlsStateShape) => {
        setThreeDState(s);
        setThreeDBuildSignal((n) => n + 1);
    }, []);

    // Stable handler that checks for warnings before applying
    const handleThreeDStateChange = useCallback(
        (s: ThreeDControlsStateShape) => {
            const warnings: string[] = [];

            const layerCount = s.colorOrder?.length ?? 0;
            if (layerCount > LAYER_WARNING_THRESHOLD) {
                warnings.push(
                    `The model will have ${layerCount} layers to build. Consider reducing colors in 2D mode first for better performance.`
                );
            }

            if (imageDimensions) {
                const totalPixels = imageDimensions.w * imageDimensions.h;
                if (totalPixels > PIXEL_WARNING_THRESHOLD) {
                    warnings.push(
                        `The image resolution is ${imageDimensions.w}\u00D7${imageDimensions.h} (${(totalPixels / 1000).toFixed(0)}k pixels). Large images may take a long time to build and use significant memory.`
                    );
                }
            }

            if (warnings.length > 0) {
                setBuildWarning({ warnings, pendingState: s });
            } else {
                applyThreeDState(s);
            }
        },
        [imageDimensions, applyThreeDState]
    );

    const confirmBuild = useCallback(() => {
        if (buildWarning) {
            applyThreeDState(buildWarning.pendingState);
            setBuildWarning(null);
        }
    }, [buildWarning, applyThreeDState]);

    const cancelBuild = useCallback(() => {
        setBuildWarning(null);
    }, []);

    return {
        threeDState,
        setThreeDState,
        threeDBuildSignal,
        buildWarning,
        handleThreeDStateChange,
        confirmBuild,
        cancelBuild,
    };
}
