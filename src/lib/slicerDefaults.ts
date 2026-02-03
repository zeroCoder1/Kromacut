export const KROMACUT_CONFIG = `<?xml version="1.0" encoding="UTF-8"?>
<config>
    <metadata key="Application" value="Kromacut"/>
    <metadata key="Author" value="vycdev"/>
    <metadata key="Website" value="https://kromacut.com/"/>
    <metadata key="GitHub" value="https://github.com/vycdev/Kromacut"/>
    <metadata key="Patreon" value="https://www.patreon.com/vycdev"/>
    <metadata key="CreationDate" value="${new Date().toISOString().split('T')[0]}"/>
</config>`;

export const MINIMAL_PROJECT_SETTINGS = {
    layer_height: '0.2',
    initial_layer_print_height: '0.2',
    wall_loops: '1',
    sparse_infill_density: '100%',
    printer_model: 'Kromacut',
    printer_settings_id: 'Kromacut 0.4 nozzle',
    nozzle_diameter: ['0.4'],
    printable_height: '300',
    filament_colour: ['#FFFFFF'],
    filament_type: ['PLA'],
    filament_settings_id: ['Generic PLA @Kromacut 0.4 nozzle'],
    filament_vendor: ['Generic'],
};
