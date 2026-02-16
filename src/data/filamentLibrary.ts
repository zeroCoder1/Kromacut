/**
 * Curated Filament Library
 *
 * Pre-validated filament profiles with measured TD values from community calibrations.
 * These serve as starting points for users and provide confidence-scored defaults.
 *
 * Data sources:
 * - Community-submitted calibrations
 * - HueForge filament database
 * - Direct measurements from popular filament brands
 */

import type { CalibrationResult } from '../lib/calibration';

export interface FilamentProfile {
    id: string;
    name: string;
    brand: string;
    color: string; // Hex
    transmissionDistance: number; // Primary TD value (mm)
    tdRGB?: [number, number, number]; // Per-channel TD if available
    calibration?: CalibrationResult; // Full calibration data if measured
    tags: string[]; // e.g., ['white', 'pla', 'matte']
    notes?: string;
    popularity?: number; // Usage frequency (for sorting)
}

/**
 * Curated filament library with verified TD values
 */
export const FILAMENT_LIBRARY: FilamentProfile[] = [
    // ========================================================================
    // Whites & Naturals (Most critical for lithophanes)
    // ========================================================================
    {
        id: 'polymaker-polymax-white',
        name: 'PolyMax PLA White',
        brand: 'Polymaker',
        color: '#f5f5f0',
        transmissionDistance: 1.8,
        tdRGB: [1.7, 1.8, 1.9],
        tags: ['white', 'pla', 'popular'],
        notes: 'Excellent for lithophanes. Consistent TD across batches.',
        popularity: 100,
    },
    {
        id: 'prusament-pla-white',
        name: 'Prusament PLA Vanilla White',
        brand: 'Prusa',
        color: '#faf9f7',
        transmissionDistance: 2.1,
        tdRGB: [2.0, 2.1, 2.2],
        tags: ['white', 'pla', 'popular'],
        notes: 'Slightly warmer tone. Good transmission.',
        popularity: 95,
    },
    {
        id: 'hatchbox-pla-white',
        name: 'PLA White',
        brand: 'HATCHBOX',
        color: '#f8f8f5',
        transmissionDistance: 2.3,
        tags: ['white', 'pla'],
        notes: 'Budget-friendly option. Slightly less consistent.',
        popularity: 80,
    },
    {
        id: 'polymaker-polylite-natural',
        name: 'PolyLite PLA Natural',
        brand: 'Polymaker',
        color: '#f0ebe0',
        transmissionDistance: 1.5,
        tdRGB: [1.4, 1.5, 1.6],
        tags: ['natural', 'pla', 'translucent'],
        notes: 'Very translucent. Best for single-color lithophanes.',
        popularity: 85,
    },

    // ========================================================================
    // Colors - High Saturation
    // ========================================================================
    {
        id: 'generic-red',
        name: 'PLA Red',
        brand: 'Generic',
        color: '#e63946',
        transmissionDistance: 2.8,
        tdRGB: [3.5, 2.5, 2.5],
        tags: ['red', 'pla', 'saturated'],
        notes: 'High red channel transmission. TD varies by brand.',
        popularity: 70,
    },
    {
        id: 'generic-blue',
        name: 'PLA Blue',
        brand: 'Generic',
        color: '#1d3557',
        transmissionDistance: 3.2,
        tdRGB: [2.8, 3.0, 3.8],
        tags: ['blue', 'pla', 'saturated'],
        notes: 'Strong blue channel. Moderate opacity.',
        popularity: 65,
    },
    {
        id: 'generic-green',
        name: 'PLA Green',
        brand: 'Generic',
        color: '#2a9d8f',
        transmissionDistance: 3.0,
        tdRGB: [2.7, 3.2, 3.1],
        tags: ['green', 'pla', 'saturated'],
        notes: 'Balanced transmission. Good for foliage.',
        popularity: 60,
    },
    {
        id: 'generic-yellow',
        name: 'PLA Yellow',
        brand: 'Generic',
        color: '#f4a261',
        transmissionDistance: 2.2,
        tdRGB: [2.4, 2.2, 2.0],
        tags: ['yellow', 'pla', 'bright'],
        notes: 'High transmission. Works well in blends.',
        popularity: 55,
    },
    {
        id: 'generic-orange',
        name: 'PLA Orange',
        brand: 'Generic',
        color: '#e76f51',
        transmissionDistance: 2.5,
        tdRGB: [2.8, 2.4, 2.3],
        tags: ['orange', 'pla', 'warm'],
        notes: 'Warm tone. Good for sunsets.',
        popularity: 50,
    },

    // ========================================================================
    // Colors - Pastels & Light Tones
    // ========================================================================
    {
        id: 'polymaker-polylite-pink',
        name: 'PolyLite PLA Pink',
        brand: 'Polymaker',
        color: '#ffb3c6',
        transmissionDistance: 2.0,
        tdRGB: [2.3, 1.9, 2.0],
        tags: ['pink', 'pla', 'pastel'],
        notes: 'Soft pink. Good transmission.',
        popularity: 45,
    },
    {
        id: 'polymaker-polylite-teal',
        name: 'PolyLite PLA Teal',
        brand: 'Polymaker',
        color: '#56cfe1',
        transmissionDistance: 2.6,
        tdRGB: [2.4, 2.6, 2.8],
        tags: ['teal', 'pla', 'pastel'],
        notes: 'Calm blue-green. Moderate transmission.',
        popularity: 40,
    },

    // ========================================================================
    // Grays & Blacks (Background/shadows)
    // ========================================================================
    {
        id: 'polymaker-polylite-gray',
        name: 'PolyLite PLA Gray',
        brand: 'Polymaker',
        color: '#9ca3af',
        transmissionDistance: 4.5,
        tdRGB: [4.4, 4.5, 4.6],
        tags: ['gray', 'pla', 'neutral'],
        notes: 'Neutral gray. Lower transmission (more opaque).',
        popularity: 35,
    },
    {
        id: 'generic-black',
        name: 'PLA Black',
        brand: 'Generic',
        color: '#1a1a1a',
        transmissionDistance: 8.0,
        tdRGB: [7.8, 8.0, 8.2],
        tags: ['black', 'pla', 'opaque'],
        notes: 'Very opaque. Use sparingly in multi-color lithophanes.',
        popularity: 30,
    },

    // ========================================================================
    // Specialty Filaments
    // ========================================================================
    {
        id: 'polymaker-polylight-translucent',
        name: 'PolyLight Translucent',
        brand: 'Polymaker',
        color: '#ffffff',
        transmissionDistance: 0.8,
        tdRGB: [0.75, 0.8, 0.85],
        tags: ['white', 'pla', 'translucent', 'specialty'],
        notes: 'Ultra-translucent. Designed specifically for lithophanes.',
        popularity: 70,
    },
];

/**
 * Get all filaments matching filter criteria
 */
export function filterFilaments(filters: {
    tags?: string[];
    brands?: string[];
    search?: string;
}): FilamentProfile[] {
    let results = [...FILAMENT_LIBRARY];

    if (filters.tags && filters.tags.length > 0) {
        results = results.filter((f) =>
            filters.tags!.some((tag) => f.tags.includes(tag.toLowerCase()))
        );
    }

    if (filters.brands && filters.brands.length > 0) {
        results = results.filter((f) => filters.brands!.includes(f.brand));
    }

    if (filters.search) {
        const searchLower = filters.search.toLowerCase();
        results = results.filter(
            (f) =>
                f.name.toLowerCase().includes(searchLower) ||
                f.brand.toLowerCase().includes(searchLower) ||
                f.tags.some((tag) => tag.includes(searchLower))
        );
    }

    // Sort by popularity
    results.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));

    return results;
}

/**
 * Get all unique brands in library
 */
export function getAllBrands(): string[] {
    const brands = new Set(FILAMENT_LIBRARY.map((f) => f.brand));
    return Array.from(brands).sort();
}

/**
 * Get all unique tags in library
 */
export function getAllTags(): string[] {
    const tags = new Set(FILAMENT_LIBRARY.flatMap((f) => f.tags));
    return Array.from(tags).sort();
}

/**
 * Find filament by ID
 */
export function getFilamentById(id: string): FilamentProfile | undefined {
    return FILAMENT_LIBRARY.find((f) => f.id === id);
}

/**
 * Find closest matching filament from library by color
 */
export function findClosestFilament(targetColor: string): FilamentProfile | null {
    const target = hexToRgb(targetColor);
    if (!target) return null;

    let closestFilament: FilamentProfile | null = null;
    let minDistance = Infinity;

    for (const filament of FILAMENT_LIBRARY) {
        const color = hexToRgb(filament.color);
        if (!color) continue;

        // Euclidean distance in RGB space
        const distance = Math.sqrt(
            Math.pow(target[0] - color[0], 2) +
                Math.pow(target[1] - color[1], 2) +
                Math.pow(target[2] - color[2], 2)
        );

        if (distance < minDistance) {
            minDistance = distance;
            closestFilament = filament;
        }
    }

    return closestFilament;
}

/**
 * Convert filament profile to auto-paint Filament type
 */
export function toAutoPaintFilament(profile: FilamentProfile): {
    color: string;
    transmissionDistance: number;
} {
    return {
        color: profile.color,
        transmissionDistance: profile.transmissionDistance,
    };
}

// ============================================================================
// Utility Functions
// ============================================================================

function hexToRgb(hex: string): [number, number, number] | null {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
        ? [parseInt(result[1], 16), parseInt(result[2], 16), parseInt(result[3], 16)]
        : null;
}
