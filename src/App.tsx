import React, { useEffect, useRef, useState, useCallback } from 'react';
import ThreeDControls from './components/ThreeDControls';
import type { ThreeDControlsStateShape } from './components/ThreeDControls';
import ThreeDView from './components/ThreeDView';
import logo from './assets/logo.png';
import tdTestImg from './assets/tdTest.png';
import CanvasPreview from './components/CanvasPreview';
import type { CanvasPreviewHandle } from './components/CanvasPreview';
import { SwatchesPanel } from './components/SwatchesPanel';
import AdjustmentsPanel from './components/AdjustmentsPanel';
import DeditherPanel from './components/DeditherPanel';
import { ADJUSTMENT_DEFAULTS } from './lib/applyAdjustments';
import SLIDER_DEFS from './components/sliderDefs';
import { useSwatches } from './hooks/useSwatches';
import type { SwatchEntry } from './hooks/useSwatches';
import { useImageHistory } from './hooks/useImageHistory';
import { useQuantize } from './hooks/useQuantize';
import Header from './components/Header';
import ModeTabs from './components/ModeTabs';
import PreviewActions from './components/PreviewActions';
import { useDropzone } from './hooks/useDropzone';
import { exportObjectToStlBlob } from './lib/exportStl';
import { exportObjectTo3MFBlob } from './lib/export3mf';
import { useAppHandlers } from './hooks/useAppHandlers';
import ResizableSplitter from './components/ResizableSplitter';
import { ControlsPanel } from './components/ControlsPanel';
import {
    AlertDialog,
    AlertDialogContent,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogAction,
    AlertDialogCancel,
} from './components/ui/alert-dialog';
// ...existing imports

const AUTOPAINT_STORAGE_KEY = 'kromacut.autopaint.v1';

type AutoPaintPersisted = Pick<ThreeDControlsStateShape, 'filaments' | 'paintMode'>;

const loadAutoPaintPersisted = (): AutoPaintPersisted | null => {
    try {
        const raw = localStorage.getItem(AUTOPAINT_STORAGE_KEY);
        if (!raw) return null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parsed = JSON.parse(raw) as any;
        if (!parsed || !Array.isArray(parsed.filaments)) return null;
        // Migrate legacy `autoPaintEnabled` boolean → `paintMode`
        const paintMode: 'manual' | 'autopaint' =
            parsed.paintMode === 'autopaint' || parsed.paintMode === 'manual'
                ? parsed.paintMode
                : parsed.autoPaintEnabled
                  ? 'autopaint'
                  : 'manual';
        return {
            filaments: parsed.filaments,
            paintMode,
        };
    } catch {
        return null;
    }
};

const saveAutoPaintPersisted = (value: AutoPaintPersisted) => {
    try {
        localStorage.setItem(AUTOPAINT_STORAGE_KEY, JSON.stringify(value));
    } catch {
        // ignore storage errors
    }
};

function App(): React.ReactElement | null {
    // dropzone state managed by hook below
    // `weight` is the algorithm parameter; `finalColors` is the postprocess target
    const [weight, setWeight] = useState<number>(128);
    const [finalColors, setFinalColors] = useState<number>(16);
    const [algorithm, setAlgorithm] = useState<string>('kmeans');
    const SWATCH_CAP = 2 ** 10;
    // default to the Auto palette
    const [selectedPalette, setSelectedPalette] = useState<string>('auto');
    const { imageSrc, setImage, clearCurrent, undo, redo, canUndo, canRedo } = useImageHistory(
        logo,
        undefined
    );
    const { swatches, swatchesLoading, invalidate, immediateOverride } = useSwatches(imageSrc);
    // adjustments managed locally inside AdjustmentsPanel now
    // initial selectedPalette derived from initial weight above
    const inputRef = useRef<HTMLInputElement | null>(null);
    const canvasPreviewRef = useRef<CanvasPreviewHandle | null>(null);
    const [showCheckerboard, setShowCheckerboard] = useState<boolean>(false);
    const [isCropMode, setIsCropMode] = useState(false);
    const [hasValidCropSelection, setHasValidCropSelection] = useState(false);
    const [isQuantizing, setIsQuantizing] = useState(false);
    const { applyQuantize } = useQuantize({
        algorithm,
        weight,
        finalColors,
        selectedPalette,
        imageSrc,
        setImage: (u, push = true) => {
            invalidate();
            setImage(u, push);
        },
        onImmediateSwatches: (colors: SwatchEntry[]) => immediateOverride(colors),
    });

    // persistent (committed) adjustments applied on redraw. Key/value map.
    const [adjustments, setAdjustments] = useState<Record<string, number>>(ADJUSTMENT_DEFAULTS);
    // epoch counter to force remount of AdjustmentsPanel when we bake & reset
    const [adjustmentsEpoch, setAdjustmentsEpoch] = useState(0);
    // UI mode toggles (2D / 3D) - UI only for now
    const [mode, setMode] = useState<'2d' | '3d'>('2d');
    const [exportingSTL, setExportingSTL] = useState(false);
    const [exportProgress, setExportProgress] = useState(0); // 0..1
    // 3D printing shared state
    const [threeDState, setThreeDState] = useState<ThreeDControlsStateShape>(() => {
        const persisted = loadAutoPaintPersisted();
        return {
            layerHeight: 0.12,
            slicerFirstLayerHeight: 0.2,
            colorSliceHeights: [],
            colorOrder: [],
            filteredSwatches: [],
            pixelSize: 0.1,
            filaments: persisted?.filaments ?? [],
            paintMode: persisted?.paintMode ?? 'manual',
        };
    });
    // Signal to force a rebuild of the 3D view when incremented
    const [threeDBuildSignal, setThreeDBuildSignal] = useState(0);
    const prevModeRef = useRef<typeof mode>(mode);
    // Track image dimensions for build warnings
    const [imageDimensions, setImageDimensions] = useState<{ w: number; h: number } | null>(null);
    // Warning dialog state
    const [buildWarning, setBuildWarning] = useState<{
        warnings: string[];
        pendingState: ThreeDControlsStateShape;
    } | null>(null);

    useEffect(() => {
        saveAutoPaintPersisted({
            filaments: threeDState.filaments,
            paintMode: threeDState.paintMode ?? 'manual',
        });
    }, [threeDState.filaments, threeDState.paintMode]);

    // No auto-build on tab switch — the user must click "Build 3D Model" / "Apply Changes".
    useEffect(() => {
        prevModeRef.current = mode;
    }, [mode]);

    // removed duplicate syncing: manual changes to the numeric input should set Auto via onWeightChange
    // redraw when image changes
    useEffect(() => {
        canvasPreviewRef.current?.redraw();
    }, [imageSrc]);

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

    const handleFiles = (file?: File) => {
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            alert('Please upload an image file');
            return;
        }
        const url = URL.createObjectURL(file);
        invalidate();
        setImage(url, true);
    };

    // removed unused handlers (inline handlers used instead)

    const clear = () => {
        clearCurrent();
        if (inputRef.current) inputRef.current.value = '';
    };

    // splitter & layout management preserved below

    // wheel/pan handled in CanvasPreview
    // startPan handled in CanvasPreview
    // resize observer handled by CanvasPreview; keep for layout redraw hook
    // Layout splitter state
    const layoutRef = useRef<HTMLDivElement | null>(null);

    const dropzone = useDropzone({ enabled: mode === '2d', onFile: handleFiles });
    const { onExportImage, onExportStl, onExport3MF, onSwatchApply, onSwatchDelete } =
        useAppHandlers({
            canvasPreviewRef,
            imageSrc,
            invalidate,
            setImage,
            setExportingSTL,
            setExportProgress,
            exportingSTL,
            exportObjectToStlBlob,
            exportObjectTo3MFBlob: (obj) =>
                exportObjectTo3MFBlob(obj, {
                    layerHeight: threeDState.layerHeight,
                    firstLayerHeight: threeDState.slicerFirstLayerHeight,
                    layerFilamentColors:
                        threeDState.paintMode === 'autopaint'
                            ? threeDState.autoPaintFilamentSwatches?.map((s) => s.hex)
                            : undefined,
                }),
            applyQuantize,
            swatches,
        });
    // Thresholds for build warnings
    const LAYER_WARNING_THRESHOLD = 64;
    const PIXEL_WARNING_THRESHOLD = 2500000;

    // Apply state without warning (used after user confirms, or when no warning needed)
    const applyThreeDState = useCallback((s: ThreeDControlsStateShape) => {
        setThreeDState(s);
        // Always bump the rebuild signal so ThreeDView is forced to build,
        // even if the serialized paramsKey happens to match a previous build.
        setThreeDBuildSignal((n) => n + 1);
    }, []);

    // Stable handler that checks for warnings before applying
    const handleThreeDStateChange = useCallback(
        (s: ThreeDControlsStateShape) => {
            const warnings: string[] = [];

            // Check layer count (each entry in colorOrder = one greedy mesh pass)
            const layerCount = s.colorOrder?.length ?? 0;
            if (layerCount > LAYER_WARNING_THRESHOLD) {
                warnings.push(
                    `The model will have ${layerCount} layers to build. Consider reducing colors in 2D mode first for better performance.`
                );
            }

            // Check image resolution
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

    // Confirm build despite warnings
    const confirmBuild = useCallback(() => {
        if (buildWarning) {
            applyThreeDState(buildWarning.pendingState);
            setBuildWarning(null);
        }
    }, [buildWarning, applyThreeDState]);

    const cancelBuild = useCallback(() => {
        setBuildWarning(null);
    }, []);

    return (
        <div className="box-border text-inherit font-sans flex flex-col flex-1 min-w-0 max-w-full min-h-0 h-screen w-full">
            <Header
                onLoadTest={() => {
                    invalidate();
                    setImage(tdTestImg, true);
                }}
            />
            <div className="flex flex-1 min-h-0 w-full" ref={layoutRef}>
                <ResizableSplitter defaultSize={30} minSize={20} maxSize={50}>
                    <aside className="w-full bg-card border-r border-border flex flex-col min-h-0">
                        <ModeTabs mode={mode} onChange={setMode} />
                        <div className="flex-1 overflow-y-auto overflow-x-auto p-4">
                            {mode === '2d' ? (
                                <>
                                    <input
                                        ref={inputRef}
                                        type="file"
                                        accept="image/*"
                                        onChange={(e) => {
                                            if (e.target.files && e.target.files[0])
                                                handleFiles(e.target.files[0]);
                                        }}
                                        className="hidden-file-input"
                                    />
                                    {/* file input stays here (hidden); uploader buttons moved to preview actions */}
                                    <div className="space-y-4">
                                        <AdjustmentsPanel
                                            key={adjustmentsEpoch}
                                            defs={SLIDER_DEFS}
                                            initial={ADJUSTMENT_DEFAULTS}
                                            onCommit={(vals) => {
                                                setAdjustments(vals);
                                                // schedule a redraw
                                                requestAnimationFrame(() =>
                                                    canvasPreviewRef.current?.redraw()
                                                );
                                            }}
                                            onBake={async () => {
                                                if (!canvasPreviewRef.current) return;
                                                try {
                                                    const blob =
                                                        await canvasPreviewRef.current.exportAdjustedImageBlob?.();
                                                    if (!blob) return;
                                                    const url = URL.createObjectURL(blob);
                                                    invalidate();
                                                    setImage(url, true);
                                                    // After baking, reset adjustments state to defaults
                                                    setAdjustments(ADJUSTMENT_DEFAULTS);
                                                    setAdjustmentsEpoch((e) => e + 1);
                                                } catch (e) {
                                                    console.warn('Bake adjustments failed', e);
                                                }
                                            }}
                                        />
                                        <DeditherPanel
                                            canvasRef={canvasPreviewRef}
                                            onApplyResult={(url) => {
                                                invalidate();
                                                setImage(url, true);
                                            }}
                                        />
                                        <ControlsPanel
                                            // finalColors controls postprocessing result count
                                            finalColors={finalColors}
                                            onFinalColorsChange={(n) => {
                                                setFinalColors(n);
                                                // changing the final colors should switch to auto palette
                                                setSelectedPalette('auto');
                                            }}
                                            // weight remains the algorithm parameter
                                            weight={weight}
                                            onWeightChange={(n) => {
                                                setWeight(n);
                                            }}
                                            algorithm={algorithm}
                                            setAlgorithm={setAlgorithm}
                                            onApply={async () => {
                                                if (isQuantizing) return;
                                                setIsQuantizing(true);
                                                await new Promise((r) => requestAnimationFrame(r));
                                                try {
                                                    await applyQuantize(canvasPreviewRef);
                                                } finally {
                                                    setIsQuantizing(false);
                                                }
                                            }}
                                            disabled={!imageSrc || isCropMode}
                                            applying={isQuantizing}
                                            weightDisabled={algorithm === 'none'}
                                            selectedPalette={selectedPalette}
                                            onPaletteSelect={(id, size) => {
                                                setSelectedPalette(id);
                                                // set the postprocess target to the palette size, but do not lock it
                                                if (id !== 'auto') setFinalColors(size);
                                            }}
                                        />
                                        <SwatchesPanel
                                            swatches={swatches}
                                            loading={swatchesLoading}
                                            cap={SWATCH_CAP}
                                            onSwatchDelete={onSwatchDelete}
                                            onSwatchApply={onSwatchApply}
                                        />
                                    </div>
                                </>
                            ) : (
                                <ThreeDControls
                                    swatches={swatches}
                                    onChange={handleThreeDStateChange}
                                    persisted={threeDState}
                                />
                            )}
                        </div>
                    </aside>
                    <main className="h-full w-full bg-background flex flex-col min-h-0">
                        <div
                            className={`flex-1 relative min-h-0 w-full ${dropzone.dragOver ? 'bg-primary/20' : ''}`}
                            onDrop={dropzone.onDrop}
                            onDragOver={dropzone.onDragOver}
                            onDragLeave={dropzone.onDragLeave}
                        >
                            {mode === '2d' ? (
                                <CanvasPreview
                                    ref={canvasPreviewRef}
                                    imageSrc={imageSrc}
                                    isCropMode={isCropMode}
                                    showCheckerboard={showCheckerboard}
                                    adjustments={adjustments}
                                    onCropSelectionChange={setHasValidCropSelection}
                                />
                            ) : (
                                <ThreeDView
                                    imageSrc={imageSrc}
                                    baseSliceHeight={0}
                                    layerHeight={threeDState.layerHeight}
                                    slicerFirstLayerHeight={threeDState.slicerFirstLayerHeight}
                                    colorSliceHeights={threeDState.colorSliceHeights}
                                    colorOrder={threeDState.colorOrder}
                                    swatches={threeDState.filteredSwatches}
                                    pixelSize={threeDState.pixelSize}
                                    rebuildSignal={threeDBuildSignal}
                                    autoPaintEnabled={threeDState.paintMode === 'autopaint'}
                                    autoPaintTotalHeight={threeDState.autoPaintResult?.totalHeight}
                                />
                            )}
                            <PreviewActions
                                mode={mode}
                                canUndo={canUndo}
                                canRedo={canRedo}
                                isCropMode={isCropMode}
                                imageAvailable={!!imageSrc}
                                hasValidCropSelection={hasValidCropSelection}
                                exportingSTL={exportingSTL}
                                exportProgress={exportProgress}
                                onUndo={undo}
                                onRedo={redo}
                                onEnterCrop={() => imageSrc && setIsCropMode(true)}
                                onSaveCrop={async () => {
                                    if (!canvasPreviewRef.current) return;
                                    const blob =
                                        await canvasPreviewRef.current.exportCroppedImage();
                                    if (!blob) return;
                                    const url = URL.createObjectURL(blob);
                                    invalidate();
                                    setImage(url, true);
                                    setIsCropMode(false);
                                }}
                                onCancelCrop={() => setIsCropMode(false)}
                                onToggleCheckerboard={() => setShowCheckerboard((s) => !s)}
                                onPickFile={() => inputRef.current?.click()}
                                onClear={clear}
                                onExportImage={onExportImage}
                                onExportStl={onExportStl}
                                onExport3MF={onExport3MF}
                            />
                        </div>
                    </main>
                </ResizableSplitter>
            </div>

            {/* Build warning dialog */}
            <AlertDialog
                open={buildWarning !== null}
                onOpenChange={(open) => !open && cancelBuild()}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Performance Warning</AlertDialogTitle>
                        <AlertDialogDescription asChild>
                            <div className="space-y-2">
                                <p>Building the 3D model may be slow due to:</p>
                                <ul className="list-disc pl-5 space-y-1">
                                    {buildWarning?.warnings.map((w, i) => (
                                        <li key={i}>{w}</li>
                                    ))}
                                </ul>
                                <p>Do you want to continue?</p>
                            </div>
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={confirmBuild}>Build Anyway</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

export default App;
