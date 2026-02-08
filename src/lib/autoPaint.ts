/**
 * Auto-Paint Algorithm for Filament Painting (HueForge-style lithophanes)
 *
 * This module implements a physically-accurate optical simulation for
 * multi-filament lithophane printing using the Beer-Lambert law.
 *
 * Key concepts:
 * 1. TRANSITION ZONES: Each filament needs enough vertical space to fully
 *    transition from the previous color to its pure color.
 * 2. CUMULATIVE HEIGHT: Total height = sum of all transition zones.
 * 3. COMPRESSION: If user sets a max height below the ideal, zones are compressed.
 * 4. LUMINANCE MAPPING: Image pixel brightness maps to position within zones.
 */

import type { Filament } from '../types';

/** RGB color representation (0-255 range) */
export interface RGB {
    r: number;
    g: number;
    b: number;
}

/** Lab color representation for perceptual color difference */
export interface Lab {
    L: number;
    a: number;
    b: number;
}

/** A transition zone between two filaments */
export interface TransitionZone {
    filamentId: string;
    filamentColor: string;
    filamentTd: number; // Transmission Distance of this filament
    startHeight: number; // mm from Z=0
    endHeight: number; // mm from Z=0
    idealThickness: number; // Uncompressed zone thickness
    actualThickness: number; // After compression
}

/** A generated layer segment from the auto-paint algorithm */
export interface AutoPaintLayer {
    filamentId: string;
    filamentColor: string;
    startHeight: number; // mm from Z=0
    endHeight: number; // mm from Z=0
}

/** Result from the auto-paint generator */
export interface AutoPaintResult {
    layers: AutoPaintLayer[];
    totalHeight: number;
    idealHeight: number; // What height would be ideal without compression
    autoHeight: number; // The default height when user hasn't set a max
    compressionRatio: number; // 1.0 = no compression, 0.5 = 50% compressed
    filamentOrder: string[]; // Filament IDs in order (dark to light)
    transitionZones: TransitionZone[]; // Detailed zone info
}

// =============================================================================
// COLOR CONVERSION UTILITIES
// =============================================================================

/**
 * Convert hex color to RGB
 */
export function hexToRgb(hex: string): RGB {
    const h = hex.replace(/^#/, '');
    return {
        r: parseInt(h.slice(0, 2), 16) || 0,
        g: parseInt(h.slice(2, 4), 16) || 0,
        b: parseInt(h.slice(4, 6), 16) || 0,
    };
}

/**
 * Convert RGB to hex
 */
export function rgbToHex(rgb: RGB): string {
    const toHex = (n: number) =>
        Math.round(Math.max(0, Math.min(255, n)))
            .toString(16)
            .padStart(2, '0');
    return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

/**
 * Convert RGB (0-255) to Lab color space for perceptual color difference
 */
export function rgbToLab(rgb: RGB): Lab {
    // First convert RGB to XYZ
    let r = rgb.r / 255;
    let g = rgb.g / 255;
    let b = rgb.b / 255;

    // sRGB gamma correction
    r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
    g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
    b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;

    r *= 100;
    g *= 100;
    b *= 100;

    // RGB to XYZ (D65 illuminant)
    const x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
    const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
    const z = r * 0.0193339 + g * 0.119192 + b * 0.9503041;

    // XYZ to Lab (D65 reference white)
    const refX = 95.047;
    const refY = 100.0;
    const refZ = 108.883;

    let xr = x / refX;
    let yr = y / refY;
    let zr = z / refZ;

    const epsilon = 0.008856;
    const kappa = 903.3;

    xr = xr > epsilon ? Math.cbrt(xr) : (kappa * xr + 16) / 116;
    yr = yr > epsilon ? Math.cbrt(yr) : (kappa * yr + 16) / 116;
    zr = zr > epsilon ? Math.cbrt(zr) : (kappa * zr + 16) / 116;

    return {
        L: 116 * yr - 16,
        a: 500 * (xr - yr),
        b: 200 * (yr - zr),
    };
}

/**
 * Calculate Delta E (CIE76) - perceptual color difference
 * A DeltaE < 1 is generally imperceptible to the human eye.
 * DeltaE < 2.3 is considered "just noticeable difference"
 */
export function deltaE(color1: RGB, color2: RGB): number {
    const lab1 = rgbToLab(color1);
    const lab2 = rgbToLab(color2);

    return Math.sqrt(
        Math.pow(lab1.L - lab2.L, 2) + Math.pow(lab1.a - lab2.a, 2) + Math.pow(lab1.b - lab2.b, 2)
    );
}

/**
 * Calculate perceived luminance (brightness) from RGB values.
 * Uses the standard sRGB luminance coefficients.
 *
 * @param color - RGB color (0-255 range)
 * @returns Luminance value (0-255 range)
 */
export function getLuminance(color: RGB): number {
    return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
}

// =============================================================================
// OPTICAL BLENDING (BEER-LAMBERT LAW)
// =============================================================================

/**
 * Calculate the resulting color when placing a semi-transparent filament
 * on top of an existing background color using the Beer-Lambert law.
 *
 * The transmission follows: T = 0.1^(thickness/TD)
 * At thickness == TD, transmission is 10% (filament definition of TD).
 *
 * @param backgroundColor - The color of the existing stack
 * @param filamentColor - The color of the filament being added
 * @param filamentTD - Transmission Distance of the filament (mm)
 * @param layerThickness - How thick the filament layer is (mm)
 * @returns The resulting blended color
 */
export function blendColors(
    backgroundColor: RGB,
    filamentColor: RGB,
    filamentTD: number,
    layerThickness: number
): RGB {
    // Prevent division by zero or invalid TD
    if (filamentTD <= 0 || layerThickness <= 0) {
        return filamentColor;
    }

    // Beer-Lambert law: transmission = 10^(-thickness/TD)
    // At thickness == TD, transmission = 10^(-1) = 0.1 (10%)
    const transmission = Math.pow(0.1, layerThickness / filamentTD);

    // Opacity is the inverse of transmission
    const opacity = 1 - transmission;

    // Linear interpolation (simple RGB mixing)
    return {
        r: filamentColor.r * opacity + backgroundColor.r * transmission,
        g: filamentColor.g * opacity + backgroundColor.g * transmission,
        b: filamentColor.b * opacity + backgroundColor.b * transmission,
    };
}

/**
 * Calculate the opacity (how opaque) a filament layer is at a given thickness.
 *
 * @param filamentTD - Transmission Distance (mm)
 * @param thickness - Layer thickness (mm)
 * @returns Opacity value (0-1)
 */
export function getOpacity(filamentTD: number, thickness: number): number {
    if (filamentTD <= 0 || thickness <= 0) return 0;
    const transmission = Math.pow(0.1, thickness / filamentTD);
    return 1 - transmission;
}

// =============================================================================
// TRANSITION ZONE CALCULATION
// =============================================================================

/**
 * DeltaE threshold for considering a color transition "complete".
 * Below this value, the blended color is perceptually indistinguishable
 * from the target pure filament color.
 */
const DELTA_E_THRESHOLD = 2.3; // "Just noticeable difference"

/**
 * Frontlit prints behave optically like a much shorter effective TD.
 * Scale user-entered TD values down for internal simulation.
 */
const FRONTLIT_TD_SCALE = 0.1;

/**
 * Simulate adding filament layers until the blended color matches the
 * target pure filament color (DeltaE < threshold), or until the filament
 * is effectively opaque (opacity target reached).
 *
 * @param backgroundColor - Starting background color
 * @param filamentColor - Target filament color
 * @param filamentTD - Transmission distance of the filament
 * @param layerHeight - Physical layer height increment
 * @returns Thickness needed for complete transition
 */
export function calculateTransitionThickness(
    backgroundColor: RGB,
    filamentColor: RGB,
    filamentTD: number,
    layerHeight: number
): number {
    // Early exit if colors are already close
    if (deltaE(backgroundColor, filamentColor) < DELTA_E_THRESHOLD) {
        return layerHeight; // Still need at least one layer
    }

    let thickness = 0;
    let currentColor = backgroundColor;

    // The cap determines the absolute maximum transition thickness.
    // At 0.7×TD, opacity ≈ 80%. At 1×TD, opacity ≈ 90%.
    // For transitions between adjacent colors in a sorted stack,
    // DeltaE convergence typically fires well before this cap.
    // We use 0.7×TD — if the color hasn't converged by ~80% opacity,
    // additional thickness gives diminishing visual returns.
    const OPACITY_CAP = 0.7;
    const maxThickness = Math.max(layerHeight, filamentTD * OPACITY_CAP);

    // Simulate adding layers until color converges or we hit the cap
    while (thickness < maxThickness) {
        thickness += layerHeight;
        currentColor = blendColors(backgroundColor, filamentColor, filamentTD, thickness);

        // Stop if the blended color is perceptually close to the target
        if (deltaE(currentColor, filamentColor) < DELTA_E_THRESHOLD) {
            break;
        }

        // Also stop if opacity is already very high — diminishing returns
        if (getOpacity(filamentTD, thickness) > 0.85) {
            break;
        }
    }

    // Snap to layerHeight grid
    return Math.min(thickness, maxThickness);
}

/**
 * Calculate the ideal model height based on cumulative transition zones.
 *
 * This simulates the full stack from darkest to lightest filament,
 * calculating how much vertical space each transition needs.
 *
 * @param sortedFilaments - Filaments sorted dark to light
 * @param layerHeight - Physical layer height
 * @param baseThickness - Minimum thickness for the first (darkest) layer
 * @returns Object with ideal height and zone breakdown
 */
export function calculateIdealHeight(
    sortedFilaments: Array<{ id: string; color: string; td: number }>,
    layerHeight: number,
    baseThickness: number = 0.6
): { idealHeight: number; zones: TransitionZone[] } {
    if (sortedFilaments.length === 0) {
        return { idealHeight: baseThickness, zones: [] };
    }

    const zones: TransitionZone[] = [];
    let currentHeight = 0;
    let currentBackgroundColor = hexToRgb(sortedFilaments[0].color);

    // Zone 1: Foundation layer (darkest filament)
    // Needs to be opaque enough to block the backlight.
    // Using Beer-Lambert: for 95% opacity → transmission = 5%
    //   0.05 = 10^(-thickness/TD)  →  thickness = TD × log10(20) ≈ TD × 1.3
    // Dark filaments have low TD (e.g. 0.5mm) → foundation ≈ 0.65mm
    const firstFilament = sortedFilaments[0];
    const opacityThickness = firstFilament.td * 1.3; // 95% opaque
    // Ensure at least the base thickness (avoid unnecessary extra layers)
    const foundationThickness = Math.max(baseThickness, opacityThickness);

    zones.push({
        filamentId: firstFilament.id,
        filamentColor: firstFilament.color,
        filamentTd: firstFilament.td,
        startHeight: 0,
        endHeight: foundationThickness,
        idealThickness: foundationThickness,
        actualThickness: foundationThickness,
    });
    currentHeight = foundationThickness;

    // Subsequent zones: each filament transitions from the previous
    for (let i = 1; i < sortedFilaments.length; i++) {
        const filament = sortedFilaments[i];
        const filamentRgb = hexToRgb(filament.color);

        // Calculate how thick this zone needs to be
        const transitionThickness = calculateTransitionThickness(
            currentBackgroundColor,
            filamentRgb,
            filament.td,
            layerHeight
        );

        zones.push({
            filamentId: filament.id,
            filamentColor: filament.color,
            filamentTd: filament.td,
            startHeight: currentHeight,
            endHeight: currentHeight + transitionThickness,
            idealThickness: transitionThickness,
            actualThickness: transitionThickness,
        });

        // Update for next iteration
        currentBackgroundColor = filamentRgb;
        currentHeight += transitionThickness;
    }

    return { idealHeight: currentHeight, zones };
}

/**
 * Apply compression to transition zones when max height is exceeded.
 *
 * @param zones - Original transition zones
 * @param maxHeight - User's maximum height constraint
 * @returns Compressed zones and compression ratio
 */
export function compressZones(
    zones: TransitionZone[],
    maxHeight: number
): { compressedZones: TransitionZone[]; compressionRatio: number } {
    if (zones.length === 0) {
        return { compressedZones: [], compressionRatio: 1 };
    }

    const idealHeight = zones[zones.length - 1].endHeight;

    if (idealHeight <= maxHeight) {
        // No compression needed
        return { compressedZones: zones, compressionRatio: 1 };
    }

    const compressionRatio = maxHeight / idealHeight;

    // Apply uniform compression to all zones
    const compressedZones: TransitionZone[] = [];
    let currentHeight = 0;

    for (const zone of zones) {
        const compressedThickness = zone.idealThickness * compressionRatio;
        compressedZones.push({
            ...zone,
            startHeight: currentHeight,
            endHeight: currentHeight + compressedThickness,
            actualThickness: compressedThickness,
        });
        currentHeight += compressedThickness;
    }

    return { compressedZones, compressionRatio };
}

// =============================================================================
// MAIN AUTO-PAINT ALGORITHM
// =============================================================================

/**
 * Generate auto-paint layers based on filaments, image data, and constraints.
 *
 * Algorithm:
 * 1. Sort filaments by luminance (dark to light)
 * 2. Calculate ideal transition zones using DeltaE simulation
 * 3. Apply compression if max height is exceeded
 * 4. Generate layer segments for the 3D model
 *
 * @param filaments - User's list of filaments with colors and TDs
 * @param imageSwatches - Distinct colors from the image (for luminance range)
 * @param layerHeight - Layer height in mm (e.g., 0.12)
 * @param firstLayerHeight - First layer height in mm (e.g., 0.20)
 * @param maxHeight - Optional maximum height constraint (undefined = auto)
 * @returns Generated layer segments with zone information
 */
export function generateAutoLayers(
    filaments: Filament[],
    imageSwatches: Array<{ hex: string }>,
    layerHeight: number,
    firstLayerHeight: number,
    maxHeight?: number
): AutoPaintResult {
    // --- STEP 1: VALIDATION ---
    if (filaments.length === 0) {
        return {
            layers: [],
            totalHeight: 0,
            idealHeight: 0,
            autoHeight: 0,
            compressionRatio: 1,
            filamentOrder: [],
            transitionZones: [],
        };
    }

    if (imageSwatches.length === 0) {
        return {
            layers: [],
            totalHeight: 0,
            idealHeight: 0,
            autoHeight: 0,
            compressionRatio: 1,
            filamentOrder: [],
            transitionZones: [],
        };
    }

    // --- STEP 2: SORT FILAMENTS BY LUMINANCE (dark to light) ---
    const sortedFilaments = [...filaments].sort((a, b) => {
        const lumA = getLuminance(hexToRgb(a.color));
        const lumB = getLuminance(hexToRgb(b.color));
        return lumA - lumB;
    });

    const filamentOrder = sortedFilaments.map((f) => f.id);

    // Apply frontlit TD scale for internal simulation
    const scaledFilaments = sortedFilaments.map((f) => ({
        ...f,
        td: f.td * FRONTLIT_TD_SCALE,
    }));

    // --- STEP 3: CALCULATE IDEAL HEIGHT WITH TRANSITION ZONES ---
    const { idealHeight, zones } = calculateIdealHeight(
        scaledFilaments.map((f) => ({ id: f.id, color: f.color, td: f.td })),
        layerHeight,
        Math.max(firstLayerHeight, layerHeight)
    );

    // --- STEP 4: APPLY COMPRESSION IF NEEDED ---
    // autoHeight = idealHeight — the physics-derived value from the
    // DeltaE convergence simulation. This is the height the algorithm
    // determines is needed for accurate color reproduction.
    // No hardcoded cap — each transition zone is already bounded by
    // opacity thresholds (85%) and DeltaE convergence (< 2.3).
    const autoHeight = idealHeight;
    const targetMaxHeight = maxHeight ?? autoHeight;
    const { compressedZones, compressionRatio } = compressZones(zones, targetMaxHeight);

    // --- STEP 5: GENERATE LAYER SEGMENTS FROM ZONES ---
    const layers: AutoPaintLayer[] = compressedZones.map((zone) => ({
        filamentId: zone.filamentId,
        filamentColor: zone.filamentColor,
        startHeight: zone.startHeight,
        endHeight: zone.endHeight,
    }));

    const totalHeight =
        compressedZones.length > 0 ? compressedZones[compressedZones.length - 1].endHeight : 0;

    return {
        layers,
        totalHeight,
        idealHeight,
        autoHeight,
        compressionRatio,
        filamentOrder,
        transitionZones: compressedZones,
    };
}

/**
 * Calculate the recommended model height based on filaments.
 * This is a quick estimate before the full zone calculation.
 *
 * @param filaments - Array of filaments
 * @returns Recommended model height in mm
 */
export function calculateRecommendedHeight(
    filaments: Array<{ color: string; td: number }>
): number {
    if (filaments.length === 0) return 2.0;

    // Sum of TDs gives a rough estimate of total transition space needed
    const totalTD = filaments.reduce((sum, f) => sum + f.td * FRONTLIT_TD_SCALE, 0);

    // Typically need about 0.8x to 1.2x the sum of TDs
    const estimated = totalTD * 0.9;

    // Clamp to reasonable bounds
    return Math.max(1.0, Math.min(15, estimated));
}

// =============================================================================
// SLICE HEIGHT CONVERSION (for ThreeDView)
// =============================================================================

/**
 * Convert auto-paint layers to the format expected by ThreeDView.
 *
 * This function generates layers at each layerHeight increment,
 * creating a graduated effect where higher layers cover progressively
 * fewer pixels (only the lightest ones).
 *
 * ThreeDView expects:
 * - colorSliceHeights: height for each swatch index
 * - colorOrder: ordering of swatch indices
 * - virtualSwatches: colors for each layer
 */
export function autoPaintToSliceHeights(
    result: AutoPaintResult,
    layerHeight: number,
    firstLayerHeight: number
): {
    colorSliceHeights: number[];
    colorOrder: number[];
    virtualSwatches: Array<{ hex: string; a: number }>;
    filamentSwatches: Array<{ hex: string; a: number }>;
} {
    if (result.layers.length === 0 || result.totalHeight <= 0) {
        return {
            colorSliceHeights: [],
            colorOrder: [],
            virtualSwatches: [],
            filamentSwatches: [],
        };
    }

    const virtualSwatches: Array<{ hex: string; a: number }> = [];
    const filamentSwatches: Array<{ hex: string; a: number }> = [];
    const colorSliceHeights: number[] = [];
    const colorOrder: number[] = [];

    const zones = result.transitionZones;

    // Generate layers at each layerHeight increment from 0 to totalHeight.
    // For each layer, simulate the Beer-Lambert blended color at that Z.
    let currentZ = 0;
    let layerIndex = 0;
    let prevZoneIndex = 0;
    let thicknessInCurrentZone = 0;

    while (currentZ < result.totalHeight) {
        const thickness = layerIndex === 0 ? Math.max(firstLayerHeight, layerHeight) : layerHeight;

        // Find which zone is active at this Z height
        let activeZoneIndex = 0;
        for (let zi = 0; zi < zones.length; zi++) {
            if (currentZ >= zones[zi].startHeight && currentZ < zones[zi].endHeight) {
                activeZoneIndex = zi;
                break;
            }
            if (currentZ >= zones[zi].startHeight) {
                activeZoneIndex = zi;
            }
        }

        // Track cumulative thickness within this zone for blending
        if (activeZoneIndex !== prevZoneIndex) {
            thicknessInCurrentZone = currentZ - zones[activeZoneIndex].startHeight + thickness;
            prevZoneIndex = activeZoneIndex;
        } else {
            thicknessInCurrentZone += thickness;
        }

        const zone = zones[activeZoneIndex];
        const filamentColor = hexToRgb(zone.filamentColor);

        // Simulate the blended color at this layer:
        // Foundation zone → pure filament color (opaque base)
        // Subsequent zones → blend filament onto the previous zone's color
        let blendedColor: RGB;
        if (activeZoneIndex === 0) {
            blendedColor = filamentColor;
        } else {
            const bgColor = hexToRgb(zones[activeZoneIndex - 1].filamentColor);
            blendedColor = blendColors(
                bgColor,
                filamentColor,
                zone.filamentTd,
                thicknessInCurrentZone
            );
        }

        virtualSwatches.push({ hex: rgbToHex(blendedColor), a: 255 });
        filamentSwatches.push({ hex: zone.filamentColor, a: 255 });
        colorSliceHeights.push(Number(thickness.toFixed(8)));
        colorOrder.push(layerIndex);

        currentZ += thickness;
        layerIndex++;

        if (layerIndex > 500) {
            console.warn('autoPaintToSliceHeights: too many layers, stopping at 500');
            break;
        }
    }

    return {
        colorSliceHeights,
        colorOrder,
        virtualSwatches,
        filamentSwatches,
    };
}

// =============================================================================
// LUMINANCE-TO-HEIGHT MAPPING
// =============================================================================

/**
 * Map a pixel's luminance to a target height within the transition zones.
 *
 * This is the key function that determines how image brightness translates
 * to physical height in the 3D model.
 *
 * The mapping works as follows:
 * - Darkest pixels (luminance = 0) → minimum height (base layer only)
 * - Lightest pixels (luminance = 1) → maximum height (all layers)
 * - Mid-tones → proportional position within the transition zones
 *
 * @param normalizedLuminance - Pixel luminance normalized to 0-1
 * @param transitionZones - The computed transition zones
 * @param totalHeight - Total model height
 * @param firstLayerHeight - First layer height
 * @returns Target height in mm
 */
export function luminanceToHeight(
    normalizedLuminance: number,
    transitionZones: TransitionZone[],
    totalHeight: number,
    firstLayerHeight: number
): number {
    if (transitionZones.length === 0) {
        return firstLayerHeight;
    }

    // Base height (darkest pixels get at least the foundation)
    const baseHeight = transitionZones[0].endHeight;

    if (normalizedLuminance <= 0) {
        return baseHeight;
    }

    if (normalizedLuminance >= 1) {
        return totalHeight;
    }

    // Linear interpolation from base to total height
    // This gives a smooth gradient where brightness = height
    return baseHeight + normalizedLuminance * (totalHeight - baseHeight);
}

// =============================================================================
// DEBUG UTILITIES
// =============================================================================

/**
 * Debug helper: simulate and log the optical stacking at each layer
 */
export function debugAutoPaint(
    filaments: Filament[],
    imageSwatches: Array<{ hex: string }>,
    layerHeight: number,
    firstLayerHeight: number,
    maxHeight?: number
): void {
    const result = generateAutoLayers(
        filaments,
        imageSwatches,
        layerHeight,
        firstLayerHeight,
        maxHeight
    );

    console.group('🎨 Auto-Paint Debug');
    console.log('Input filaments:', filaments);
    console.log('Max height constraint:', maxHeight ?? 'auto');
    console.log('---');
    console.log('Ideal height:', result.idealHeight.toFixed(2), 'mm');
    console.log('Actual height:', result.totalHeight.toFixed(2), 'mm');
    console.log(
        'Compression:',
        result.compressionRatio < 1
            ? `${((1 - result.compressionRatio) * 100).toFixed(1)}% compressed`
            : 'None'
    );
    console.log('Filament order (dark→light):', result.filamentOrder);
    console.log('---');
    console.log('Transition Zones:');
    result.transitionZones.forEach((zone, i) => {
        const status = zone.actualThickness < zone.idealThickness ? '⚠️ compressed' : '✓';
        console.log(
            `  ${i + 1}. ${zone.filamentColor} | ${zone.startHeight.toFixed(2)}mm → ${zone.endHeight.toFixed(2)}mm | ` +
                `Ideal: ${zone.idealThickness.toFixed(2)}mm, Actual: ${zone.actualThickness.toFixed(2)}mm ${status}`
        );
    });
    console.groupEnd();
}
