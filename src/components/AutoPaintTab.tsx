import React from 'react';
import { Card } from '@/components/ui/card';
import { NumberInput, Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Plus, Trash2, Sparkles, Save, Download, Upload, FilePlus } from 'lucide-react';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { TabsContent } from '@/components/ui/tabs';
import type { AutoPaintResult, TransitionZone } from '../lib/autoPaint';
import type { AutoPaintProfile } from '../lib/profileManager';
import type { Filament, Swatch } from '../types';
import FilamentRow from './FilamentRow';

interface AutoPaintSliceData {
    virtualSwatches: Swatch[];
    colorSliceHeights: number[];
    colorOrder: number[];
    filamentSwatches: Swatch[];
}

interface AutoPaintTabProps {
    // Filament state
    filaments: Filament[];
    addFilament: () => void;
    removeFilament: (id: string) => void;
    updateFilament: (id: string, updates: Partial<Omit<Filament, 'id'>>) => void;

    // Profile state
    profiles: AutoPaintProfile[];
    activeProfileId: string | null;
    isDirty: boolean;
    showSaveNewPopover: boolean;
    setShowSaveNewPopover: (v: boolean) => void;
    saveProfileName: string;
    setSaveProfileName: (v: string) => void;
    importFeedback: string | null;
    importInputRef: React.RefObject<HTMLInputElement | null>;
    handleSaveNewProfile: (name: string) => void;
    handleOverwriteProfile: () => void;
    handleLoadProfile: (id: string) => void;
    handleDeleteProfile: (id: string) => void;
    handleExportProfile: () => void;
    handleImportFile: (e: React.ChangeEvent<HTMLInputElement>) => void;

    // Auto-paint state
    autoPaintMaxHeight: number | undefined;
    setAutoPaintMaxHeight: (v: number | undefined) => void;
    autoPaintResult?: AutoPaintResult;
    autoPaintSliceData?: AutoPaintSliceData;

    // Image colors
    filteredCount: number;
}

export default function AutoPaintTab({
    filaments,
    addFilament,
    removeFilament,
    updateFilament,
    profiles,
    activeProfileId,
    isDirty,
    showSaveNewPopover,
    setShowSaveNewPopover,
    saveProfileName,
    setSaveProfileName,
    importFeedback,
    importInputRef,
    handleSaveNewProfile,
    handleOverwriteProfile,
    handleLoadProfile,
    handleDeleteProfile,
    handleExportProfile,
    handleImportFile,
    autoPaintMaxHeight,
    setAutoPaintMaxHeight,
    autoPaintResult,
    autoPaintSliceData,
    filteredCount,
}: AutoPaintTabProps) {
    return (
        <TabsContent value="autopaint" forceMount className="data-[state=inactive]:hidden">
            <Card className="p-4 border border-border/50">
                <div className="space-y-1">
                    <h3 className="text-sm font-semibold text-foreground">Auto-paint</h3>
                    <p className="text-xs text-muted-foreground">
                        Define filament colors and transmission distances for automatic painting
                    </p>
                </div>
                <div className="h-px bg-border/50 my-4" />

                {/* Profiles Section */}
                <div className="space-y-2 mb-4">
                    <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-foreground">Profiles</span>
                        {activeProfileId && isDirty && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 border border-amber-500/20">
                                Unsaved changes
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-1.5">
                        <Select value={activeProfileId ?? ''} onValueChange={handleLoadProfile}>
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
                                        <SelectItem key={p.id} value={p.id} className="text-xs">
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
                        <Popover open={showSaveNewPopover} onOpenChange={setShowSaveNewPopover}>
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
                                    <h4 className="text-xs font-semibold">Save New Profile</h4>
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
                                        onClick={() => handleSaveNewProfile(saveProfileName)}
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
                                    placeholder={autoPaintResult?.totalHeight?.toFixed(1) ?? 'Auto'}
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
                                                Math.max(0.5, Math.min(20, autoPaintMaxHeight))
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
                                        Total height: {autoPaintResult.totalHeight.toFixed(2)}mm
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
                                                autoPaintMaxHeight < autoPaintResult.autoHeight &&
                                                zone.actualThickness < zone.idealThickness - 0.01;
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
                                                            backgroundColor: zone.filamentColor,
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
                                                            {zone.startHeight.toFixed(2)}mm →{' '}
                                                            {zone.endHeight.toFixed(2)}mm
                                                            <span className="ml-1 text-primary font-medium">
                                                                (Δ
                                                                {zone.actualThickness.toFixed(2)}
                                                                mm)
                                                            </span>
                                                            {isCompressed && (
                                                                <span className="ml-1 text-amber-600/70">
                                                                    ideal:{' '}
                                                                    {zone.idealThickness.toFixed(2)}
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
                    {filaments.length > 0 && filteredCount === 0 && (
                        <div className="mt-3 p-2 rounded-md bg-amber-500/10 border border-amber-500/20 text-amber-600 text-[10px]">
                            Load an image to generate auto-paint layers
                        </div>
                    )}
                </div>
            </Card>
        </TabsContent>
    );
}
