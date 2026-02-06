import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card } from '@/components/ui/card';
import { NumberInput, Input } from '@/components/ui/input';
import ThreeDColorRow from './ThreeDColorRow';
import { Sortable, SortableContent, SortableOverlay } from '@/components/ui/sortable';
import { Button } from '@/components/ui/button';
import {
    Check,
    RotateCcw,
    Plus,
    Trash2,
    Sparkles,
    Wand2,
    Save,
    Download,
    Upload,
    FilePlus,
} from 'lucide-react';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { HexColorPicker } from 'react-colorful';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
    generateAutoLayers,
    autoPaintToSliceHeights,
    type AutoPaintResult,
    type TransitionZone,
} from '../lib/autoPaint';
import {
    type AutoPaintProfile,
    loadProfiles,
    saveProfilesToStorage,
    createProfile,
    overwriteProfile,
    deleteProfile as deleteProfileFromList,
    importProfiles,
    parseProfileFile,
    exportProfileBlob,
    profileFileName,
    loadLastProfileId,
    saveLastProfileId,
} from '../lib/profileManager';

/**
 * Estimate Transmission Distance (TD) from a hex color.
 *
 * TD is related to how much light passes through the filament:
 * - Darker colors absorb more light → lower TD (≈0.5mm)
 * - Lighter colors are more transparent → higher TD (≈6.0mm)
 * - Saturated colors can be slightly clearer than gray of same luminance
 *
 * This is an approximation based on luminance with adjustments for saturation.
 */
function estimateTDFromColor(hex: string): number {
    const h = hex.replace(/^#/, '');
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;

    // Calculate luminance (perceived brightness)
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    // Calculate saturation (highly saturated colors tend to be clearer)
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max;

    // Base TD from luminance: map 0-1 luminance to 0.5-6.0 TD (linear)
    let estimatedTD = 0.5 + luminance * 5.5;

    // Saturated colors can be clearer than gray of same luminance
    if (luminance < 0.9) {
        estimatedTD += saturation * 1.5;
    }

    // Clamp to reasonable range and round to 1 decimal
    return Math.round(Math.max(0.4, Math.min(7.5, estimatedTD)) * 10) / 10;
}

type Swatch = { hex: string; a: number };

export interface Filament {
    id: string;
    color: string;
    td: number;
}

export interface ThreeDControlsStateShape {
    layerHeight: number;
    slicerFirstLayerHeight: number;
    colorSliceHeights: number[];
    colorOrder: number[];
    filteredSwatches: Swatch[];
    pixelSize: number; // mm per pixel (XY)
    filaments: Filament[];
    paintMode: 'manual' | 'autopaint';
    // Auto-paint computed state (only used when paintMode is 'autopaint')
    autoPaintResult?: AutoPaintResult;
    autoPaintSwatches?: Swatch[];
    autoPaintFilamentSwatches?: Swatch[];
}

const PRINT_SETTINGS_STORAGE_KEY = 'kromacut:3d-print-settings';
const DEFAULT_PRINT_SETTINGS = {
    layerHeight: 0.12,
    slicerFirstLayerHeight: 0.2,
    pixelSize: 0.1,
};

type PrintSettings = {
    layerHeight: number;
    slicerFirstLayerHeight: number;
    pixelSize: number;
};

const clampNumber = (value: number, min: number, max: number) =>
    Math.max(min, Math.min(max, value));

const loadPrintSettingsFromStorage = (): PrintSettings | null => {
    if (typeof window === 'undefined') return null;
    try {
        const raw = window.localStorage.getItem(PRINT_SETTINGS_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<PrintSettings>;
        const layerHeight =
            typeof parsed.layerHeight === 'number' && isFinite(parsed.layerHeight)
                ? clampNumber(parsed.layerHeight, 0.01, 10)
                : DEFAULT_PRINT_SETTINGS.layerHeight;
        const slicerFirstLayerHeight =
            typeof parsed.slicerFirstLayerHeight === 'number' &&
            isFinite(parsed.slicerFirstLayerHeight)
                ? clampNumber(parsed.slicerFirstLayerHeight, 0, 10)
                : DEFAULT_PRINT_SETTINGS.slicerFirstLayerHeight;
        const pixelSize =
            typeof parsed.pixelSize === 'number' && isFinite(parsed.pixelSize)
                ? clampNumber(parsed.pixelSize, 0.01, 10)
                : DEFAULT_PRINT_SETTINGS.pixelSize;
        return { layerHeight, slicerFirstLayerHeight, pixelSize };
    } catch {
        return null;
    }
};

const savePrintSettingsToStorage = (settings: PrintSettings) => {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(PRINT_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
        // Ignore storage failures (e.g., private mode, quota exceeded).
    }
};

interface ThreeDControlsProps {
    swatches: Swatch[] | null;
    onChange?: (state: ThreeDControlsStateShape) => void;
    /**
     * Persisted state from a previous mount used to hydrate this component
     * when the user switches away from 3D mode and comes back later.
     */
    persisted?: ThreeDControlsStateShape | null;
}

// Sub-component for individual filament rows to handle local input state
const FilamentRow = React.memo(function FilamentRow({
    filament,
    onUpdate,
    onRemove,
}: {
    filament: Filament;
    onUpdate: (id: string, updates: Partial<Omit<Filament, 'id'>>) => void;
    onRemove: (id: string) => void;
}) {
    // Local state for the input value to allow free typing
    const [localTd, setLocalTd] = useState<string>(filament.td.toString());
    // Local state for color to allow smooth dragging without frequent parent updates
    const [localColor, setLocalColor] = useState<string>(filament.color);

    // Sync local TD state if prop changes externally
    useEffect(() => {
        setLocalTd(filament.td.toString());
    }, [filament.td]);

    // Sync local color state if prop changes externally
    useEffect(() => {
        setLocalColor(filament.color);
    }, [filament.color]);

    // Debounced update for color
    useEffect(() => {
        const timer = setTimeout(() => {
            if (localColor !== filament.color) {
                onUpdate(filament.id, { color: localColor });
            }
        }, 200);
        return () => clearTimeout(timer);
    }, [localColor, filament.id, filament.color, onUpdate]);

    const handleBlur = () => {
        let val = parseFloat(localTd);
        if (isNaN(val)) {
            // Revert to current prop value if invalid
            setLocalTd(filament.td.toString());
            return;
        }
        // Clamp value
        val = Math.min(10, Math.max(0.1, val));
        // Update parent
        onUpdate(filament.id, { td: val });
        // Update local display to clamped value
        setLocalTd(val.toString());
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            handleBlur();
            (e.target as HTMLInputElement).blur();
        }
    };

    return (
        <div className="flex items-center gap-2 p-2 rounded-md border border-border/40 bg-card hover:border-border/80 transition-colors">
            {/* Color Picker Popover */}
            <Popover>
                <PopoverTrigger asChild>
                    <button
                        type="button"
                        className="w-8 h-8 rounded-full border-2 border-border shadow-sm flex-shrink-0 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-transform hover:scale-105 cursor-pointer"
                        style={{ backgroundColor: localColor }}
                        title="Change filament color"
                    />
                </PopoverTrigger>
                <PopoverContent className="w-auto p-3" align="start">
                    <div className="space-y-3">
                        <h4 className="font-medium text-sm">Pick Color</h4>
                        <HexColorPicker color={localColor} onChange={setLocalColor} />
                        <div className="flex gap-2 items-center">
                            <span className="text-xs text-muted-foreground">Hex</span>
                            <Input
                                value={localColor}
                                onChange={(e) => setLocalColor(e.target.value)}
                                className="h-7 text-xs font-mono"
                            />
                        </div>
                    </div>
                </PopoverContent>
            </Popover>

            {/* Transmission Distance Input */}
            <div className="flex-1 min-w-0">
                <div className="relative">
                    <Input
                        type="number"
                        min={0.1}
                        max={10}
                        step={0.1}
                        value={localTd}
                        onChange={(e) => setLocalTd(e.target.value)}
                        onBlur={handleBlur}
                        onKeyDown={handleKeyDown}
                        className="h-8 text-sm pr-8"
                    />
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">
                        TD
                    </div>
                </div>
            </div>

            {/* Auto-compute TD Button */}
            <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                    const estimatedTd = estimateTDFromColor(localColor);
                    setLocalTd(estimatedTd.toString());
                    onUpdate(filament.id, { td: estimatedTd });
                }}
                className="h-8 w-8 text-muted-foreground hover:text-amber-600 hover:bg-amber-600/10 cursor-pointer"
                title="Auto-estimate TD from color"
            >
                <Wand2 className="w-4 h-4" />
            </Button>

            {/* Delete Button */}
            <Button
                variant="ghost"
                size="icon"
                onClick={() => onRemove(filament.id)}
                className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10 cursor-pointer"
                title="Remove filament"
            >
                <Trash2 className="w-4 h-4" />
            </Button>
        </div>
    );
});

export default function ThreeDControls({ swatches, onChange, persisted }: ThreeDControlsProps) {
    const [initialState] = useState(() => {
        const loadedProfiles = loadProfiles();
        const lastId = loadLastProfileId();
        const activeProfile = lastId ? loadedProfiles.find((p) => p.id === lastId) : null;
        return {
            profiles: loadedProfiles,
            activeProfileId: activeProfile ? activeProfile.id : null,
            // Only use profile filaments if no persisted filaments AND we have an active profile
            initialFilaments: activeProfile
                ? activeProfile.filaments.map((f) => ({ ...f }))
                : (persisted?.filaments?.length ?? 0) > 0
                  ? persisted!.filaments
                  : [],
        };
    });

    const [initialPrintSettings] = useState(() => {
        const stored = loadPrintSettingsFromStorage();
        return {
            layerHeight:
                stored?.layerHeight ?? persisted?.layerHeight ?? DEFAULT_PRINT_SETTINGS.layerHeight,
            slicerFirstLayerHeight:
                stored?.slicerFirstLayerHeight ??
                persisted?.slicerFirstLayerHeight ??
                DEFAULT_PRINT_SETTINGS.slicerFirstLayerHeight,
            pixelSize:
                stored?.pixelSize ?? persisted?.pixelSize ?? DEFAULT_PRINT_SETTINGS.pixelSize,
        };
    });

    const [layerHeight, setLayerHeight] = useState<number>(initialPrintSettings.layerHeight); // mm
    const [slicerFirstLayerHeight, setSlicerFirstLayerHeight] = useState<number>(
        initialPrintSettings.slicerFirstLayerHeight
    );
    const [colorSliceHeights, setColorSliceHeights] = useState<number[]>(
        persisted?.colorSliceHeights?.slice() ?? []
    );
    const [pixelSize, setPixelSize] = useState<number>(initialPrintSettings.pixelSize); // mm per pixel (XY plane)
    const [filaments, setFilaments] = useState<Filament[]>(initialState.initialFilaments);
    const [paintMode, setPaintMode] = useState<'manual' | 'autopaint'>(
        persisted?.paintMode ?? 'manual'
    );
    // Max height constraint for auto-paint (undefined = use ideal/automatic height)
    const [autoPaintMaxHeight, setAutoPaintMaxHeight] = useState<number | undefined>(undefined);

    // Profile management state
    const [profiles, setProfiles] = useState<AutoPaintProfile[]>(initialState.profiles);
    const [activeProfileId, setActiveProfileId] = useState<string | null>(
        initialState.activeProfileId
    );
    const [showSaveNewPopover, setShowSaveNewPopover] = useState(false);
    const [saveProfileName, setSaveProfileName] = useState('');
    const [importFeedback, setImportFeedback] = useState<string | null>(null);
    const importInputRef = useRef<HTMLInputElement>(null);

    // Dirty state: detect if current filaments differ from the active profile's
    const isDirty = useMemo(() => {
        if (!activeProfileId) return false;
        const active = profiles.find((p) => p.id === activeProfileId);
        if (!active) return false;
        if (active.filaments.length !== filaments.length) return true;
        return active.filaments.some(
            (af, i) => af.color !== filaments[i].color || af.td !== filaments[i].td
        );
    }, [activeProfileId, profiles, filaments]);

    // Save New: always creates a new profile
    const handleSaveNewProfile = useCallback(
        (name: string) => {
            if (!name.trim()) return;
            const newProfile = createProfile(name, filaments);
            const updated = [...profiles, newProfile];
            setProfiles(updated);
            saveProfilesToStorage(updated);
            setActiveProfileId(newProfile.id);
            saveLastProfileId(newProfile.id);
            setShowSaveNewPopover(false);
            setSaveProfileName('');
        },
        [filaments, profiles]
    );

    // Save (overwrite): updates existing profile in-place
    const handleOverwriteProfile = useCallback(() => {
        if (!activeProfileId) return;
        const updated = overwriteProfile(profiles, activeProfileId, filaments);
        setProfiles(updated);
        saveProfilesToStorage(updated);
    }, [activeProfileId, filaments, profiles]);

    const handleLoadProfile = useCallback(
        (id: string) => {
            const profile = profiles.find((p) => p.id === id);
            if (!profile) return;
            setActiveProfileId(id);
            saveLastProfileId(id);
            setFilaments(profile.filaments.map((f) => ({ ...f })));
        },
        [profiles]
    );

    const handleDeleteProfile = useCallback(
        (id: string) => {
            const updated = deleteProfileFromList(profiles, id);
            setProfiles(updated);
            saveProfilesToStorage(updated);
            if (activeProfileId === id) {
                setActiveProfileId(null);
                saveLastProfileId(null);
            }
        },
        [profiles, activeProfileId]
    );

    const handleExportProfile = useCallback(() => {
        const active = profiles.find((p) => p.id === activeProfileId);
        const profile = createProfile(active?.name ?? 'Exported Profile', filaments);
        // Preserve original ID if exporting active profile
        if (active) profile.id = active.id;

        const blob = exportProfileBlob(profile);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = profileFileName(profile.name);
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }, [filaments, profiles, activeProfileId]);

    const handleImportFile = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                const incoming = parseProfileFile(reader.result as string);
                if (!incoming) {
                    console.error('Invalid profile file');
                    return;
                }
                const result = importProfiles(profiles, incoming);
                setProfiles(result.profiles);
                saveProfilesToStorage(result.profiles);

                // Build feedback message
                const parts: string[] = [];
                if (result.imported.length > 0) parts.push(`${result.imported.length} imported`);
                if (result.overwritten.length > 0)
                    parts.push(`${result.overwritten.length} overwritten`);
                if (result.skipped.length > 0)
                    parts.push(`${result.skipped.length} skipped (duplicates)`);
                if (result.renamed.length > 0) parts.push(`${result.renamed.length} renamed`);
                setImportFeedback(parts.join(', ') || 'No profiles found');

                // Auto-load the first imported profile
                if (result.imported.length > 0) {
                    const first = result.imported[0];
                    setActiveProfileId(first.id);
                    saveLastProfileId(first.id);
                    setFilaments(first.filaments.map((f) => ({ ...f })));
                }
            };
            reader.readAsText(file);
            e.target.value = '';
        },
        [profiles]
    );

    // Clear import feedback after a few seconds
    useEffect(() => {
        if (!importFeedback) return;
        const timer = setTimeout(() => setImportFeedback(null), 4000);
        return () => clearTimeout(timer);
    }, [importFeedback]);

    useEffect(() => {
        savePrintSettingsToStorage({ layerHeight, slicerFirstLayerHeight, pixelSize });
    }, [layerHeight, slicerFirstLayerHeight, pixelSize]);

    // derive non-transparent swatches once per render and memoize
    const filtered = useMemo(() => {
        return swatches ? swatches.filter((s) => s.a !== 0) : [];
    }, [swatches]);

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
            hydratedRef.current = true; // states already initialized from persisted above
        }
    }, [persisted]);

    // Note: baseSliceHeight is intentionally freeform now (no snapping to layerHeight).
    // We still enforce reasonable bounds when the user edits it.

    // Initialize or resize per-color slice heights and preserve ordering when swatches change.
    useEffect(() => {
        // If we have no swatches currently (e.g., initial mount while upstream still loading),
        // avoid clearing previously persisted state. We'll wait for real data.
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
            // Only store valid, finite heights
            if (typeof prevHeight === 'number' && isFinite(prevHeight) && prevHeight >= 0) {
                heightMap.set(key, prevHeight);
            }
        }

        const nextHeights = filtered.map((s) => {
            const key = s.hex + ':' + s.a;
            const existing = heightMap.get(key);
            // Guard against invalid existing values
            const isValid = typeof existing === 'number' && isFinite(existing) && existing >= 0;
            const base = isValid ? existing : layerHeight;
            const clamped = Math.max(layerHeight, Math.min(10, base));
            // Guard against division by zero or invalid layerHeight
            if (!layerHeight || !isFinite(layerHeight) || layerHeight <= 0) {
                return isValid ? base : 0.2; // fallback to base or safe default
            }
            const multiple = Math.round(clamped / layerHeight) * layerHeight;
            const snapped = Math.max(layerHeight, Math.min(10, multiple));
            return Number(snapped.toFixed(8));
        });
        setColorSliceHeights(nextHeights);

        // Reconstruct order using previous colorOrder mapping if available.
        const nextOrder: number[] = [];
        if (prevOrder.length && prevFiltered.length) {
            // prevOrder contains indices into prevFiltered; iterate in that order.
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

        // Sort remaining colors by luminance (dark -> light)
        const getLum = (hex: string) => {
            const c = hex.replace('#', '');
            const r = parseInt(c.slice(0, 2), 16) / 255;
            const g = parseInt(c.slice(2, 4), 16) / 255;
            const b = parseInt(c.slice(4, 6), 16) / 255;
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        remaining.sort((a, b) => getLum(filtered[a].hex) - getLum(filtered[b].hex));

        nextOrder.push(...remaining);
        setColorOrder(nextOrder);

        // Stash for next diff
        prevFilteredRef.current = filtered.slice();
        prevHeightsRef.current = nextHeights.slice();
        prevOrderRef.current = nextOrder.slice();
    }, [filtered, layerHeight]);

    // stable per-row change handler so memoized rows don't re-render due to
    // a new function identity being created each parent render
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

    const handleResetPrintSettings = useCallback(() => {
        setLayerHeight(DEFAULT_PRINT_SETTINGS.layerHeight);
        setSlicerFirstLayerHeight(DEFAULT_PRINT_SETTINGS.slicerFirstLayerHeight);
        setPixelSize(DEFAULT_PRINT_SETTINGS.pixelSize);
    }, []);

    const handleResetHeights = useCallback(() => {
        if (filtered.length === 0) return;

        // Reset heights based on default logic
        // First, re-sort indices by luminance to establish the "default" order
        const getLum = (hex: string) => {
            const c = hex.replace('#', '');
            const r = parseInt(c.slice(0, 2), 16) / 255;
            const g = parseInt(c.slice(2, 4), 16) / 255;
            const b = parseInt(c.slice(4, 6), 16) / 255;
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };

        // Create an array of indices [0, 1, ..., N-1]
        const indices = filtered.map((_, i) => i);
        // Sort indices based on the luminance of the swatch at that index
        indices.sort((a, b) => getLum(filtered[a].hex) - getLum(filtered[b].hex));

        // Now reset heights. Since we are resetting everything, we can assign the
        // "first layer height" logic to the first item in the NEW sorted order.
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

    // Handle sortable reordering
    const handleColorOrderChange = useCallback((newOrder: string[]) => {
        const newColorOrder = newOrder.map((v) => Number(v));
        setColorOrder(newColorOrder);
        prevOrderRef.current = newColorOrder.slice();
    }, []);

    // Filament handlers
    const addFilament = useCallback(() => {
        const defaultColor = '#808080';
        setFilaments((prev) => [
            ...prev,
            {
                id: Math.random().toString(36).substring(2, 9),
                color: defaultColor,
                td: estimateTDFromColor(defaultColor),
            },
        ]);
    }, []);

    const removeFilament = useCallback((id: string) => {
        setFilaments((prev) => prev.filter((f) => f.id !== id));
    }, []);

    const updateFilament = useCallback((id: string, updates: Partial<Omit<Filament, 'id'>>) => {
        setFilaments((prev) => prev.map((f) => (f.id === id ? { ...f, ...updates } : f)));
    }, []);


    // Compute auto-paint result when enabled and filaments are configured
    const autoPaintResult = useMemo<AutoPaintResult | undefined>(() => {
        if (paintMode !== 'autopaint' || filaments.length === 0 || filtered.length === 0) {
            return undefined;
        }
        return generateAutoLayers(
            filaments,
            filtered.map((s) => ({ hex: s.hex })),
            layerHeight,
            slicerFirstLayerHeight,
            autoPaintMaxHeight // Pass max height constraint
        );
    }, [paintMode, filaments, filtered, layerHeight, slicerFirstLayerHeight, autoPaintMaxHeight]);

    // Convert auto-paint result to slice heights format
    const autoPaintSliceData = useMemo(() => {
        if (!autoPaintResult) return undefined;
        return autoPaintToSliceHeights(autoPaintResult, layerHeight, slicerFirstLayerHeight);
    }, [autoPaintResult, layerHeight, slicerFirstLayerHeight]);

    // Apply handler - explicitly triggers the rebuild
    const handleApply = useCallback(() => {
        if (!onChange) return;

        // When auto-paint is active and we have computed layers, use those
        if (paintMode === 'autopaint' && autoPaintSliceData && autoPaintResult) {
            onChange({
                layerHeight,
                slicerFirstLayerHeight,
                colorSliceHeights: autoPaintSliceData.colorSliceHeights,
                colorOrder: autoPaintSliceData.colorOrder,
                filteredSwatches: autoPaintSliceData.virtualSwatches,
                pixelSize,
                filaments,
                paintMode,
                autoPaintResult,
                autoPaintSwatches: autoPaintSliceData.virtualSwatches,
                autoPaintFilamentSwatches: autoPaintSliceData.filamentSwatches,
            });
        } else {
            // Standard mode: use manual color slice heights
            onChange({
                layerHeight,
                slicerFirstLayerHeight,
                colorSliceHeights,
                colorOrder,
                filteredSwatches: filtered,
                pixelSize,
                filaments,
                paintMode,
            });
        }
    }, [
        onChange,
        layerHeight,
        slicerFirstLayerHeight,
        colorSliceHeights,
        colorOrder,
        filtered,
        pixelSize,
        filaments,
        paintMode,
        autoPaintResult,
        autoPaintSliceData,
    ]);

    // No auto-apply on mount — the user must click "Apply Changes" to build the 3D model.

    // Prepare dynamic 3D print instruction data derived from current control state
    type SwapEntry =
        | { type: 'start'; swatch: Swatch }
        | { type: 'swap'; swatch: Swatch; layer: number; height: number };

    const swapPlan = useMemo(() => {
        // When auto-paint is active and we have computed layers, use those
        if (paintMode === 'autopaint' && autoPaintResult && autoPaintResult.layers.length > 0) {
            const plan: SwapEntry[] = [];
            autoPaintResult.layers.forEach(
                (
                    layer: { filamentColor: string; startHeight: number; endHeight: number },
                    idx: number
                ) => {
                    const sw: Swatch = { hex: layer.filamentColor, a: 255 };
                    if (idx === 0) {
                        plan.push({ type: 'start', swatch: sw });
                    } else {
                        // Calculate layer number at the swap point
                        const heightAt = layer.startHeight;
                        const effFirst = Math.max(0, slicerFirstLayerHeight || 0);
                        let layerNum = 1;
                        if (layerHeight > 0) {
                            const delta = Math.max(0, heightAt - effFirst);
                            layerNum = 2 + Math.round(delta / layerHeight);
                        }
                        plan.push({
                            type: 'swap',
                            swatch: sw,
                            layer: layerNum,
                            height: heightAt,
                        });
                    }
                }
            );
            return plan;
        }

        // Standard mode: Build cumulative slice heights following the same logic used by the renderer
        const cumulativeHeights: number[] = [];
        let run = 0;
        for (let pos = 0; pos < colorOrder.length; pos++) {
            const fi = colorOrder[pos];
            const h = Number(colorSliceHeights[fi] ?? 0) || 0;
            const eff = pos === 0 ? Math.max(h, slicerFirstLayerHeight || 0) : h;
            run += eff;
            cumulativeHeights[pos] = run;
        }

        // Build swap plan entries (typed)
        const plan: SwapEntry[] = [];
        for (let pos = 0; pos < colorOrder.length; pos++) {
            const fi = colorOrder[pos];
            const sw = filtered[fi];
            if (!sw) continue;
            if (pos === 0) {
                plan.push({ type: 'start', swatch: sw });
                continue;
            }
            const prevCum = cumulativeHeights[pos - 1] ?? 0;
            const heightAt = Math.max(0, prevCum);
            // Map geometry height to slicer layer index using slicer's first layer height.
            // We report the layer whose top is at or above this height, matching slicer UI labels.
            const effFirst = Math.max(0, slicerFirstLayerHeight || 0);
            let layerNum = 1;
            let displayHeight = heightAt; // fallback
            if (layerHeight > 0) {
                const delta = Math.max(0, heightAt - effFirst);
                layerNum = 2 + Math.round(delta / layerHeight);
                // Display height corresponds to the Z height of the layer in slicer
                displayHeight = effFirst + (layerNum - 1) * layerHeight;
            }
            plan.push({
                type: 'swap',
                swatch: sw,
                layer: layerNum,
                height: displayHeight,
            });
        }
        return plan;
    }, [
        colorOrder,
        colorSliceHeights,
        filtered,
        layerHeight,
        slicerFirstLayerHeight,
        paintMode,
        autoPaintResult,
    ]);

    // Build a plain-text representation of the instructions for copying
    const buildInstructionsText = () => {
        const lines: string[] = [];
        lines.push('3D Print Instructions');
        lines.push('---------------------');
        lines.push(`Layer height: ${layerHeight.toFixed(3)} mm`);
        lines.push(`First layer height: ${slicerFirstLayerHeight.toFixed(3)} mm`);
        // static recommended settings
        lines.push('Recommended: Layer loops: 1; Infill: 100%');
        lines.push('');

        if (swapPlan.length) {
            const first = swapPlan[0];
            if (first.type === 'start') lines.push(`Start with color: ${first.swatch.hex}`);
        }

        lines.push('');
        lines.push('Color swap plan:');
        if (swapPlan.length <= 1) {
            lines.push('- No swaps — only one color configured.');
        } else {
            // number the entries for clarity
            let idx = 1;
            for (const entry of swapPlan) {
                if (entry.type === 'start') {
                    lines.push(`${idx}. Start with ${entry.swatch.hex}`);
                } else {
                    lines.push(
                        `${idx}. Swap to ${entry.swatch.hex} at layer ${
                            entry.layer
                        } (~${entry.height.toFixed(3)} mm)`
                    );
                }
                idx++;
            }
        }
        lines.push('');
        lines.push('Notes: Heights are approximate. Confirm in slicer before printing.');
        lines.push('');
        lines.push('---------------------');
        lines.push('Made with Kromacut by vycdev!');
        return lines.join('\n');
    };

    // Clipboard copy with fallback and brief copied feedback
    const [copied, setCopied] = useState(false);
    const copyTimerRef = useRef<number | null>(null);
    const copyToClipboard = async () => {
        const text = buildInstructionsText();
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
            } else {
                // fallback for older browsers
                const ta = document.createElement('textarea');
                ta.value = text;
                // avoid scrolling to bottom
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.focus();
                ta.select();
                document.execCommand('copy');
                ta.remove();
            }
            setCopied(true);
            if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
            copyTimerRef.current = window.setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            // best-effort: ignore failures silently for now
            console.error('Copy to clipboard failed', err);
        }
    };

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

    return (
        <div className="space-y-4">
            {/* Apply button */}
            <div className="flex justify-end">
                <Button
                    onClick={handleApply}
                    className="w-full bg-green-600 hover:bg-green-700 text-white font-semibold transition-all duration-200 shadow-md hover:shadow-lg active:scale-95 gap-1.5"
                >
                    <Check className="w-4 h-4" />
                    <span>Build 3D Model</span>
                </Button>
            </div>

            {/* Printing Parameters Card */}
            <Card className="p-4 border border-border/50">
                <div className="flex items-start justify-between gap-2">
                    <div className="space-y-1">
                        <h3 className="text-sm font-semibold text-foreground">3D Print Settings</h3>
                        <p className="text-xs text-muted-foreground">
                            Configure your printing parameters
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={handleResetPrintSettings}
                        title="Reset print settings to default"
                        aria-label="Reset print settings"
                        className="h-7 w-7 flex-shrink-0 flex items-center justify-center rounded-md text-muted-foreground hover:text-amber-600 hover:bg-amber-600/15 transition-colors select-none cursor-pointer"
                    >
                        <RotateCcw className="w-4 h-4" />
                    </button>
                </div>
                <div className="h-px bg-border/50 my-4" />
                <div className="space-y-4">
                    {/* Pixel size (XY scaling) */}
                    <div className="space-y-3">
                        <label className="block space-y-3">
                            <div className="flex justify-between items-center">
                                <span className="font-semibold text-foreground">
                                    Pixel Size (XY)
                                </span>
                                <span className="text-xs px-2 py-1 rounded-full bg-primary/10 text-primary font-medium">
                                    mm/pixel
                                </span>
                            </div>
                            <NumberInput
                                min={0.01}
                                max={10}
                                step={0.01}
                                value={pixelSize}
                                onChange={(e) => {
                                    const v = Number(e.target.value);
                                    if (Number.isNaN(v)) return;
                                    setPixelSize(Math.min(10, v));
                                }}
                                onBlur={() => {
                                    setPixelSize((prev) => Math.max(0.01, prev));
                                }}
                            />
                        </label>
                    </div>

                    {/* Layer height */}
                    <div className="space-y-3">
                        <label className="block space-y-3">
                            <div className="flex justify-between items-center">
                                <span className="font-semibold text-foreground">Layer Height</span>
                                <span className="text-xs px-2 py-1 rounded-full bg-primary/10 text-primary font-medium">
                                    mm
                                </span>
                            </div>
                            <NumberInput
                                min={0.01}
                                max={10}
                                step={0.01}
                                value={layerHeight}
                                onChange={(e) => {
                                    const v = Number(e.target.value);
                                    if (!Number.isNaN(v) && v >= 0 && v <= 10 && isFinite(v)) {
                                        setLayerHeight(v);
                                    }
                                }}
                                onBlur={() => {
                                    setLayerHeight((prev) => Math.max(0.01, prev));
                                }}
                            />
                        </label>
                    </div>

                    {/* Slicer first layer height */}
                    <div className="space-y-3">
                        <label className="block space-y-3">
                            <div className="flex justify-between items-center">
                                <span className="font-semibold text-foreground">
                                    First Layer Height
                                </span>
                                <span className="text-xs px-2 py-1 rounded-full bg-primary/10 text-primary font-medium">
                                    mm
                                </span>
                            </div>
                            <NumberInput
                                min={0}
                                max={10}
                                step={0.01}
                                value={slicerFirstLayerHeight}
                                onChange={(e) => {
                                    const v = Number(e.target.value);
                                    if (Number.isNaN(v)) return;
                                    const clamped = Math.max(0, Math.min(10, v));
                                    setSlicerFirstLayerHeight(clamped);
                                }}
                            />
                        </label>
                    </div>

                    {/* Base slice height removed: first color height represents base thickness */}
                </div>
            </Card>

            {/* Paint Mode Tabs */}
            <Tabs
                value={paintMode}
                onValueChange={(v) => setPaintMode(v as 'manual' | 'autopaint')}
            >
                <TabsList className="w-full">
                    <TabsTrigger value="manual" className="flex-1">
                        Manual
                    </TabsTrigger>
                    <TabsTrigger value="autopaint" className="flex-1">
                        Auto-paint
                    </TabsTrigger>
                </TabsList>

                {/* Auto-paint Tab */}
                <TabsContent value="autopaint">
                    <Card className="p-4 border border-border/50">
                        <div className="space-y-1">
                            <h3 className="text-sm font-semibold text-foreground">
                                Auto-paint
                            </h3>
                            <p className="text-xs text-muted-foreground">
                                Define filament colors and transmission distances for automatic
                                painting
                            </p>
                        </div>
                        <div className="h-px bg-border/50 my-4" />

                        {/* Profiles Section */}
                        <div className="space-y-2 mb-4">
                            <div className="flex items-center gap-2">
                                <span className="text-xs font-semibold text-foreground">
                                    Profiles
                                </span>
                                {activeProfileId && isDirty && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 border border-amber-500/20">
                                        Unsaved changes
                                    </span>
                                )}
                            </div>
                            <div className="flex items-center gap-1.5">
                                <Select
                                    value={activeProfileId ?? ''}
                                    onValueChange={handleLoadProfile}
                                >
                                    <SelectTrigger className="h-8 text-xs flex-1">
                                        <SelectValue placeholder="Unsaved Configuration" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {profiles.length === 0 ? (
                                            <div className="px-2 py-1.5 text-xs text-muted-foreground">
                                                No saved profiles
                                            </div>
                                        ) : (
                                            profiles.map((p) => (
                                                <SelectItem
                                                    key={p.id}
                                                    value={p.id}
                                                    className="text-xs"
                                                >
                                                    <div className="flex items-center gap-2">
                                                        <div className="flex gap-0.5">
                                                            {p.filaments.slice(0, 4).map((f, i) => (
                                                                <span
                                                                    key={i}
                                                                    className="w-3 h-3 rounded-full border border-border/50"
                                                                    style={{
                                                                        backgroundColor: f.color,
                                                                    }}
                                                                />
                                                            ))}
                                                            {p.filaments.length > 4 && (
                                                                <span className="text-[9px] text-muted-foreground ml-0.5">
                                                                    +{p.filaments.length - 4}
                                                                </span>
                                                            )}
                                                        </div>
                                                        <span>{p.name}</span>
                                                    </div>
                                                </SelectItem>
                                            ))
                                        )}
                                    </SelectContent>
                                </Select>

                                {/* Save (overwrite active profile) */}
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-muted-foreground hover:text-primary cursor-pointer flex-shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
                                    title="Save changes to current profile"
                                    disabled={!activeProfileId || !isDirty}
                                    onClick={handleOverwriteProfile}
                                >
                                    <Save className="w-4 h-4" />
                                </Button>

                                {/* Save New */}
                                <Popover
                                    open={showSaveNewPopover}
                                    onOpenChange={setShowSaveNewPopover}
                                >
                                    <PopoverTrigger asChild>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-8 w-8 text-muted-foreground hover:text-primary cursor-pointer flex-shrink-0"
                                            title="Save as new profile"
                                        >
                                            <FilePlus className="w-4 h-4" />
                                        </Button>
                                    </PopoverTrigger>
                                    <PopoverContent className="w-64 p-3" align="end">
                                        <div className="space-y-2">
                                            <h4 className="text-xs font-semibold">
                                                Save New Profile
                                            </h4>
                                            <Input
                                                placeholder="Profile name..."
                                                value={saveProfileName}
                                                onChange={(e) => setSaveProfileName(e.target.value)}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter') {
                                                        handleSaveNewProfile(saveProfileName);
                                                    }
                                                }}
                                                className="h-8 text-xs"
                                                autoFocus
                                            />
                                            <Button
                                                size="sm"
                                                onClick={() =>
                                                    handleSaveNewProfile(saveProfileName)
                                                }
                                                disabled={!saveProfileName.trim()}
                                                className="w-full h-7 text-xs cursor-pointer"
                                            >
                                                Save
                                            </Button>
                                        </div>
                                    </PopoverContent>
                                </Popover>

                                {/* Import */}
                                <input
                                    ref={importInputRef}
                                    type="file"
                                    accept=".kapp,.json"
                                    className="hidden"
                                    onChange={handleImportFile}
                                />
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-muted-foreground hover:text-primary cursor-pointer flex-shrink-0"
                                    title="Import profile from file"
                                    onClick={() => importInputRef.current?.click()}
                                >
                                    <Upload className="w-4 h-4" />
                                </Button>

                                {/* Export */}
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-muted-foreground hover:text-primary cursor-pointer flex-shrink-0"
                                    title="Export current filaments as .kapp file"
                                    onClick={handleExportProfile}
                                    disabled={filaments.length === 0}
                                >
                                    <Download className="w-4 h-4" />
                                </Button>

                                {/* Delete */}
                                {activeProfileId && (
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10 cursor-pointer flex-shrink-0"
                                        title="Delete selected profile"
                                        onClick={() => handleDeleteProfile(activeProfileId)}
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </Button>
                                )}
                            </div>

                            {/* Import feedback */}
                            {importFeedback && (
                                <div className="text-[10px] px-2 py-1 rounded bg-primary/10 text-primary border border-primary/20">
                                    {importFeedback}
                                </div>
                            )}
                        </div>

                        <div className="space-y-3">
                            {filaments.length === 0 ? (
                                <div className="text-center py-4 text-xs text-muted-foreground bg-muted/20 rounded-lg border border-dashed border-border">
                                    No filaments added
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    {filaments.map((f) => (
                                        <FilamentRow
                                            key={f.id}
                                            filament={f}
                                            onUpdate={updateFilament}
                                            onRemove={removeFilament}
                                        />
                                    ))}
                                </div>
                            )}
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={addFilament}
                                className="w-full text-xs gap-1.5 h-8 border-dashed border-border hover:border-primary/50 hover:bg-primary/5 text-muted-foreground hover:text-primary cursor-pointer"
                            >
                                <Plus className="w-3.5 h-3.5" />
                                Add Filament
                            </Button>

                            {/* Max Height Constraint */}
                            {filaments.length > 0 && (
                                <div className="space-y-2 pt-2">
                                    <div className="flex items-center justify-between">
                                        <label className="text-xs font-medium text-foreground">
                                            Max Height
                                        </label>
                                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                                            mm
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <NumberInput
                                            min={0.5}
                                            max={20}
                                            step={0.1}
                                            value={autoPaintMaxHeight ?? ''}
                                            placeholder={
                                                autoPaintResult?.totalHeight?.toFixed(1) ?? 'Auto'
                                            }
                                            onChange={(e) => {
                                                const v = e.target.value;
                                                if (v === '' || v === undefined) {
                                                    setAutoPaintMaxHeight(undefined);
                                                } else {
                                                    const num = Number(v);
                                                    if (!isNaN(num) && num > 0) {
                                                        setAutoPaintMaxHeight(num);
                                                    }
                                                }
                                            }}
                                            onBlur={() => {
                                                if (autoPaintMaxHeight !== undefined) {
                                                    setAutoPaintMaxHeight(
                                                        Math.max(
                                                            0.5,
                                                            Math.min(20, autoPaintMaxHeight)
                                                        )
                                                    );
                                                }
                                            }}
                                            className="flex-1"
                                        />
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => setAutoPaintMaxHeight(undefined)}
                                            className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
                                            title="Use automatic height"
                                        >
                                            Auto
                                        </Button>
                                    </div>
                                    {autoPaintResult && (
                                        <div className="text-[10px] text-muted-foreground">
                                            Height: {autoPaintResult.totalHeight.toFixed(2)}mm
                                            {autoPaintMaxHeight === undefined && (
                                                <span className="ml-1 text-primary">(auto)</span>
                                            )}
                                            {autoPaintMaxHeight !== undefined &&
                                                autoPaintMaxHeight < autoPaintResult.autoHeight && (
                                                    <span className="ml-2 text-amber-600">
                                                        ⚠️ compressed below auto (
                                                        {autoPaintResult.autoHeight.toFixed(1)}mm)
                                                    </span>
                                                )}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Auto-paint transition zones preview */}
                            {autoPaintResult && autoPaintResult.transitionZones.length > 0 && (
                                <>
                                    <div className="h-px bg-border/50 my-4" />
                                    <div className="space-y-2">
                                        <div className="flex items-center gap-2">
                                            <Sparkles className="w-4 h-4 text-amber-500" />
                                            <span className="text-xs font-semibold text-foreground">
                                                Transition Zones
                                            </span>
                                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
                                                {autoPaintResult.transitionZones.length} zones
                                            </span>
                                        </div>
                                        <div className="text-[10px] text-muted-foreground space-y-0.5">
                                            <div>
                                                Total height:{' '}
                                                {autoPaintResult.totalHeight.toFixed(2)}mm
                                                {autoPaintSliceData && (
                                                    <span className="ml-2 text-muted-foreground/70">
                                                        ({autoPaintSliceData.virtualSwatches.length}{' '}
                                                        physical layers)
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                        <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                                            {autoPaintResult.transitionZones.map(
                                                (zone: TransitionZone, idx: number) => {
                                                    const isCompressed =
                                                        autoPaintMaxHeight !== undefined &&
                                                        autoPaintMaxHeight <
                                                            autoPaintResult.autoHeight &&
                                                        zone.actualThickness <
                                                            zone.idealThickness - 0.01;
                                                    return (
                                                        <div
                                                            key={`zone-${idx}`}
                                                            className={`flex items-center gap-2 p-2 rounded-md border ${
                                                                isCompressed
                                                                    ? 'bg-amber-500/5 border-amber-500/30'
                                                                    : 'bg-muted/30 border-border/30'
                                                            }`}
                                                        >
                                                            <span
                                                                className="w-5 h-5 rounded-full border border-border flex-shrink-0 shadow-sm"
                                                                style={{
                                                                    backgroundColor:
                                                                        zone.filamentColor,
                                                                }}
                                                            />
                                                            <div className="flex-1 min-w-0">
                                                                <div className="flex items-center gap-1.5">
                                                                    <span className="text-[10px] font-mono text-foreground">
                                                                        {zone.filamentColor}
                                                                    </span>
                                                                    {isCompressed && (
                                                                        <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-600 font-medium">
                                                                            compressed
                                                                        </span>
                                                                    )}
                                                                </div>
                                                                <div className="text-[9px] text-muted-foreground">
                                                                    {zone.startHeight.toFixed(2)}mm
                                                                    → {zone.endHeight.toFixed(2)}mm
                                                                    <span className="ml-1 text-primary font-medium">
                                                                        (Δ
                                                                        {zone.actualThickness.toFixed(
                                                                            2
                                                                        )}
                                                                        mm)
                                                                    </span>
                                                                    {isCompressed && (
                                                                        <span className="ml-1 text-amber-600/70">
                                                                            ideal:{' '}
                                                                            {zone.idealThickness.toFixed(
                                                                                2
                                                                            )}
                                                                            mm
                                                                        </span>
                                                                    )}
                                                                </div>
                                                            </div>
                                                        </div>
                                                    );
                                                }
                                            )}
                                        </div>
                                    </div>
                                </>
                            )}

                            {/* Warning when no filaments */}
                            {filaments.length === 0 && (
                                <div className="mt-3 p-2 rounded-md bg-amber-500/10 border border-amber-500/20 text-amber-600 text-[10px]">
                                    Add at least one filament to generate auto-paint layers
                                </div>
                            )}

                            {/* Warning when no image colors */}
                            {filaments.length > 0 && filtered.length === 0 && (
                                <div className="mt-3 p-2 rounded-md bg-amber-500/10 border border-amber-500/20 text-amber-600 text-[10px]">
                                    Load an image to generate auto-paint layers
                                </div>
                            )}
                        </div>
                    </Card>
                </TabsContent>

                {/* Manual Tab */}
                <TabsContent value="manual">
                    <Card className="p-4 border border-border/50">
                        <div className="flex justify-between items-center mb-4">
                            <div>
                                <h4 className="font-semibold text-foreground">
                                    Color Slice Heights
                                </h4>
                                <p className="text-xs text-muted-foreground mt-1">
                                    Drag to reorder, adjust sliders to customize
                                </p>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={handleResetHeights}
                                    title="Reset all heights and sort by luminance"
                                    aria-label="Reset all heights and sorting"
                                    className="h-7 w-7 flex-shrink-0 flex items-center justify-center rounded-md text-muted-foreground hover:text-amber-600 hover:bg-amber-600/15 transition-colors select-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    <RotateCcw className="w-4 h-4" />
                                </button>
                                <span className="px-2 py-1 rounded-full bg-primary/10 text-primary text-xs font-semibold">
                                    {filtered.length} colors
                                </span>
                            </div>
                        </div>
                        <div className="h-px bg-border/50 mb-4" />
                        <Sortable
                            value={displayOrder.map(String)}
                            onValueChange={handleColorOrderChange}
                            orientation="vertical"
                        >
                            <SortableContent asChild>
                                <div className="space-y-2">
                                    {displayOrder.map((fi, idx) => {
                                        const s = filtered[fi];
                                        const val = colorSliceHeights[fi] ?? layerHeight;
                                        const isFirst = idx === 0;
                                        const minForRow = isFirst
                                            ? Math.max(layerHeight, slicerFirstLayerHeight)
                                            : layerHeight;
                                        return (
                                            <ThreeDColorRow
                                                key={`${s.hex}-${fi}`}
                                                fi={fi}
                                                hex={s.hex}
                                                value={val}
                                                layerHeight={layerHeight}
                                                minHeight={minForRow}
                                                onChange={onRowChange}
                                            />
                                        );
                                    })}
                                </div>
                            </SortableContent>
                            <SortableOverlay>
                                <div className="rounded-lg bg-primary/10 h-11" />
                            </SortableOverlay>
                        </Sortable>
                    </Card>
                </TabsContent>
            </Tabs>

            {/* 3D printing instruction group (dynamic) */}
            <Card className="p-4 border border-border/50 mt-6">
                <div className="flex justify-between items-start mb-4">
                    <div>
                        <h4 className="font-semibold text-foreground">Print Instructions</h4>
                        <p className="text-xs text-muted-foreground mt-1">
                            Generated swap plan for your printer
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={copyToClipboard}
                        title="Copy print instructions to clipboard"
                        aria-pressed={copied}
                        className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-200 ${
                            copied
                                ? 'bg-green-600 text-white'
                                : 'bg-primary text-primary-foreground hover:bg-primary/90'
                        }`}
                    >
                        {copied ? '✓ Copied!' : 'Copy'}
                    </button>
                </div>

                <div className="h-px bg-border/50 mb-4" />

                <div className="space-y-4 text-sm">
                    {/* Recommended Settings */}
                    <div className="p-3 rounded-lg bg-primary/5 border border-primary/20">
                        <div className="font-semibold text-foreground mb-2">
                            Recommended Settings
                        </div>
                        <div className="space-y-1 text-muted-foreground text-xs">
                            <div>
                                • Wall loops: <span className="text-foreground font-medium">1</span>
                            </div>
                            <div>
                                • Infill: <span className="text-foreground font-medium">100%</span>
                            </div>
                            <div>
                                • Layer height:{' '}
                                <span className="text-foreground font-mono">
                                    {layerHeight.toFixed(3)} mm
                                </span>
                            </div>
                            <div>
                                • First layer height:{' '}
                                <span className="text-foreground font-mono">
                                    {slicerFirstLayerHeight.toFixed(3)} mm
                                </span>
                            </div>
                        </div>
                    </div>

                    {/* Start Color */}
                    <div>
                        <div className="font-semibold text-foreground mb-3">Start with Color</div>
                        {swapPlan.length && swapPlan[0].type === 'start' ? (
                            (() => {
                                const sw = swapPlan[0].swatch;
                                return (
                                    <div className="flex items-center gap-3 p-4 rounded-lg bg-primary/5 border-2 border-primary/30 shadow-sm">
                                        <span
                                            className="block w-8 h-8 rounded-md border-2 border-border flex-shrink-0 shadow-md"
                                            style={{ background: sw.hex }}
                                            title={sw.hex}
                                        />
                                        <span className="font-mono text-sm font-semibold text-foreground">
                                            {sw.hex}
                                        </span>
                                    </div>
                                );
                            })()
                        ) : (
                            <div className="text-muted-foreground text-sm p-3 rounded-lg bg-muted/30">
                                —
                            </div>
                        )}
                    </div>

                    {/* Color Swap Plan */}
                    <div>
                        <div className="font-semibold text-foreground mb-2">Color Swap Plan</div>
                        {swapPlan.length <= 1 ? (
                            <div className="text-muted-foreground text-sm p-3 rounded-lg bg-accent/5 border border-border/50">
                                Only one color configured — no swaps needed.
                            </div>
                        ) : (
                            <ol className="space-y-2">
                                {swapPlan.map((entry, idx) => {
                                    if (entry.type === 'start') return null;
                                    return (
                                        <li
                                            key={idx}
                                            className="flex items-start gap-2 text-muted-foreground text-xs p-2 rounded bg-accent/5"
                                        >
                                            <span className="text-primary font-semibold flex-shrink-0">
                                                {idx}.
                                            </span>
                                            <div className="flex-1 flex flex-col gap-1.5">
                                                <div className="flex items-center gap-2">
                                                    <span>Swap to</span>
                                                    <span
                                                        className="inline-block w-4 h-4 rounded border border-border flex-shrink-0"
                                                        style={{ background: entry.swatch.hex }}
                                                    />
                                                    <span className="font-mono text-foreground">
                                                        {entry.swatch.hex}
                                                    </span>
                                                </div>
                                                <div>
                                                    at layer{' '}
                                                    <span className="font-semibold text-foreground">
                                                        {entry.layer}
                                                    </span>{' '}
                                                    (~
                                                    <span className="font-mono text-foreground">
                                                        {entry.height.toFixed(3)} mm
                                                    </span>
                                                    )
                                                </div>
                                            </div>
                                        </li>
                                    );
                                })}
                            </ol>
                        )}
                    </div>

                    <div className="text-xs text-muted-foreground p-3 rounded-lg bg-accent/5 border border-border/50">
                        <span>ℹ️</span>{' '}
                        <span className="italic">
                            Heights are approximate. Always confirm in your slicer before printing.
                        </span>
                    </div>
                </div>
            </Card>
        </div>
    );
}
