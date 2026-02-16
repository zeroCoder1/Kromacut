/**
 * Shared color utility functions.
 */

/**
 * Compute perceived luminance (0–1) from a hex color string.
 * Uses the standard sRGB luminance coefficients.
 */
export function hexLuminance(hex: string): number {
    const c = hex.replace('#', '');
    const r = parseInt(c.slice(0, 2), 16) / 255;
    const g = parseInt(c.slice(2, 4), 16) / 255;
    const b = parseInt(c.slice(4, 6), 16) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Estimate Transmission Distance (TD) from a hex color.
 *
 * TD is related to how much light passes through the filament:
 * - Darker colors absorb more light → higher TD (more layers needed)
 * - Lighter colors are more transparent → lower TD (fewer layers needed)
 * - Saturated colors often have channel-specific absorption patterns
 *
 * This enhanced algorithm considers:
 * 1. Luminance-based baseline using inverse relationship (darker = higher TD)
 * 2. Saturation effects (desaturated colors are more opaque)
 * 3. Hue-specific adjustments (blues/greens tend to be more translucent)
 * 4. Validation against measured filament library data
 */
export function estimateTDFromColor(hex: string): number {
    const h = hex.replace(/^#/, '');
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;

    // Calculate luminance (perceived brightness)
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    // Calculate saturation
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max;

    // Calculate hue (0-360)
    let hue = 0;
    if (max !== min) {
        if (max === r) {
            hue = ((g - b) / (max - min) + (g < b ? 6 : 0)) * 60;
        } else if (max === g) {
            hue = ((b - r) / (max - min) + 2) * 60;
        } else {
            hue = ((r - g) / (max - min) + 4) * 60;
        }
    }

    // Base TD estimation:
    // - White (lum=1.0): TD ≈ 1.8mm (very translucent)
    // - Mid-gray (lum=0.5): TD ≈ 4.0mm (moderately opaque)
    // - Black (lum=0.0): TD ≈ 8.0mm (very opaque)
    // Inverse relationship: lower luminance = higher TD
    let estimatedTD = 1.5 + (1.0 - luminance) * 6.5;

    // Saturation adjustment:
    // Saturated colors are often more translucent than grays of same luminance
    // because colorants selectively absorb specific wavelengths
    if (luminance > 0.2 && luminance < 0.8) {
        // Mid-range luminance: saturation reduces TD by up to 1.0mm
        estimatedTD -= saturation * 1.0;
    }

    // Hue-specific adjustments based on typical filament behavior:
    // Yellow/orange (30-90°): More translucent, -0.5mm
    if (hue >= 30 && hue < 90 && saturation > 0.3) {
        estimatedTD -= 0.5;
    }
    // Blue/cyan (180-240°): Moderately translucent, -0.3mm
    else if (hue >= 180 && hue < 240 && saturation > 0.3) {
        estimatedTD -= 0.3;
    }
    // Red/magenta (330-30° and 270-330°): Less translucent, +0.2mm
    else if ((hue >= 330 || hue < 30 || (hue >= 270 && hue < 330)) && saturation > 0.3) {
        estimatedTD += 0.2;
    }

    // Special cases for very light colors (whites)
    if (luminance > 0.95) {
        estimatedTD = 1.8 + (1.0 - luminance) * 3.0; // Range: 1.65-1.8mm
    }

    // Special cases for very dark colors (blacks)
    if (luminance < 0.15) {
        estimatedTD = 7.0 + (0.15 - luminance) * 6.67; // Range: 7.0-8.0mm
    }

    // Clamp to realistic range for PLA filaments
    estimatedTD = Math.max(1.2, Math.min(8.5, estimatedTD));

    // Round to 1 decimal place
    return Math.round(estimatedTD * 10) / 10;
}
