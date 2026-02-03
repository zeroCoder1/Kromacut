import JSZip from 'jszip';
import * as THREE from 'three';

export interface Export3MFOptions {
    layerHeight?: number;
    firstLayerHeight?: number;
}

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = (Math.random() * 16) | 0,
            v = c == 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

export async function exportObjectTo3MFBlob(
    root: THREE.Object3D,
    options?: Export3MFOptions
): Promise<Blob> {
    const zip = new JSZip();

    // [Content_Types].xml
    const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;
    zip.file('[Content_Types].xml', contentTypes);

    // _rels/.rels
    const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;
    zip.folder('_rels')?.file('.rels', rels);

    // Collect meshes
    const meshes: THREE.Mesh[] = [];
    root.updateMatrixWorld(true);
    root.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
            const m = obj as THREE.Mesh;
            if (m.geometry && m.visible) {
                meshes.push(m);
            }
        }
    });

    if (meshes.length === 0) throw new Error('No meshes to export');

    // Collect materials (colors)
    // We map hex string -> index in basematerials
    const colorMap = new Map<string, number>();
    const colors: string[] = [];

    const getMaterialIndex = (material: THREE.Material | THREE.Material[]): number => {
        const mat = Array.isArray(material) ? material[0] : material;
        let hex = 'FFFFFF';
        if ('color' in mat && (mat as THREE.MeshStandardMaterial).color) {
            hex = (mat as THREE.MeshStandardMaterial).color.getHexString().toUpperCase();
        }
        if (!colorMap.has(hex)) {
            colorMap.set(hex, colors.length);
            colors.push(hex);
        }
        return colorMap.get(hex)!;
    };

    // Pre-calculate all materials so we can write the header correctly
    for (const mesh of meshes) {
        getMaterialIndex(mesh.material);
    }

    // Build object resources using a chunked writer to avoid OOM with massive arrays
    const xmlParts: string[] = [];
    let currentChunk = '';
    // Reduced chunk size to 10MB to be safer with string concatenation limits and memory pressure
    const CHUNK_SIZE = 10 * 1024 * 1024;

    const write = (str: string) => {
        currentChunk += str;
        if (currentChunk.length > CHUNK_SIZE) {
            xmlParts.push(currentChunk);
            currentChunk = '';
        }
    };

    // IDs: 1 = BaseMaterials, 2..N = Objects
    const baseMatId = 1;
    let nextId = 2;

    // Helper to format float - Optimized to avoid string allocations (toFixed/replace)
    const f = (n: number) => {
        // Round to 5 decimal places
        return (Math.round(n * 100000) / 100000).toString();
    };

    // Vector helper
    const v = new THREE.Vector3();

    // Store IDs of generated mesh objects to group them later
    const componentIds: number[] = [];
    const componentMeta: { id: number; name: string }[] = [];

    // Header and BaseMaterials
    // Updated namespace to 2015 Core spec to ensure slicer compatibility
    // Added BambuStudio namespace to help with preset/metadata recognition in modern slicers (Bambu/Orca/Creality)
    // Added Production Extension (p) for UUID support which is often required for robust object tracking in slicers
    let header = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <metadata name="BambuStudio:3mfVersion">1</metadata>
`;
    if (options?.layerHeight !== undefined) {
        header += ` <metadata name="slic3rpe:layer_height">${options.layerHeight}</metadata>
`;
    }
    if (options?.firstLayerHeight !== undefined) {
        header += ` <metadata name="slic3rpe:first_layer_height">${options.firstLayerHeight}</metadata>
`;
    }
    header += ` <resources>
`;
    
    // Write Base Materials if we have any
    if (colors.length > 0) {
        header += `  <basematerials id="${baseMatId}">
`;
        for (const hex of colors) {
            header += `   <base name="${hex}" displaycolor="#${hex}FF" />
`;
        }
        header += `  </basematerials>
`;
    }
    
    write(header);

    // Yield every N vertices/triangles to allow GC and UI updates
    const YIELD_EVERY = 5000;
    let opsSinceYield = 0;

    for (let i = 0; i < meshes.length; i++) {
        const mesh = meshes[i];
        const matIdx = getMaterialIndex(mesh.material);
        const objectId = nextId++;
        componentIds.push(objectId);
        
        let hex = 'FFFFFF';
        if ('color' in mesh.material && (mesh.material as THREE.MeshStandardMaterial).color) {
            hex = (mesh.material as THREE.MeshStandardMaterial).color.getHexString().toUpperCase();
        }
        const objName = `Layer ${i + 1} (#${hex})`;
        componentMeta.push({ id: objectId, name: objName });
        const objUuid = generateUUID();

        write(`<object id="${objectId}" p:UUID="${objUuid}" pid="${baseMatId}" pindex="${matIdx}" type="model" name="${objName}">
`);
        write(` <mesh>
`);
        write(`  <vertices>
`);

        const geom = mesh.geometry;
        const pos = geom.getAttribute('position');
        const index = geom.getIndex();
        
        const count = pos.count;
        for (let j = 0; j < count; j++) {
            v.fromBufferAttribute(pos, j).applyMatrix4(mesh.matrixWorld);
            write(`   <vertex x="${f(v.x)}" y="${f(v.y)}" z="${f(v.z)}" />
`);
            
            opsSinceYield++;
            if (opsSinceYield > YIELD_EVERY) {
                opsSinceYield = 0;
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }
        write(`  </vertices>
`);
        write(`  <triangles>
`);

        if (index) {
            for (let j = 0; j < index.count; j += 3) {
                write(`   <triangle v1="${index.getX(j)}" v2="${index.getX(j+1)}" v3="${index.getX(j+2)}" />
`);
                opsSinceYield++;
                if (opsSinceYield > YIELD_EVERY) {
                    opsSinceYield = 0;
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }
        } else {
            for (let j = 0; j < pos.count; j += 3) {
                write(`   <triangle v1="${j}" v2="${j+1}" v3="${j+2}" />
`);
                opsSinceYield++;
                if (opsSinceYield > YIELD_EVERY) {
                    opsSinceYield = 0;
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }
        }
        
        write(`  </triangles>
`);
        write(` </mesh>
`);
        write(`</object>
`);
    }

    // Assembly Object
    const assemblyId = nextId++;
    const assemblyUuid = generateUUID();
    write(`<object id="${assemblyId}" p:UUID="${assemblyUuid}" type="model" name="Kromacut Model">
`);
    write(` <components>
`);
    for (const id of componentIds) {
        const compUuid = generateUUID();
        write(`  <component objectid="${id}" p:UUID="${compUuid}" />
`);
    }
    write(` </components>
`);
    write(`</object>
`);

    write(` </resources>
`);
    write(` <build p:UUID="${generateUUID()}">
`);
    write(`<item objectid="${assemblyId}" p:UUID="${generateUUID()}" />
`);
    write(` </build>
`);
    write(`</model>`);

    // Flush remaining chunk
    if (currentChunk.length > 0) {
        xmlParts.push(currentChunk);
    }

    const finalBlob = new Blob(xmlParts, { type: 'text/xml' });

    zip.folder('3D')?.file('3dmodel.model', finalBlob);

    // Generate Metadata/model_settings.config
    // This is required for Bambu Studio / Orca Slicer / Creality Print to correctly identify
    // the multipart object structure and assign names/settings, avoiding the "profile selection" prompt
    // and enabling correct color assignment visualization.
    let modelSettings = `<?xml version="1.0" encoding="UTF-8"?>
<config>
 <object id="${assemblyId}">
  <metadata key="name" value="Kromacut Model"/>
`;
    for (const comp of componentMeta) {
        const safeName = comp.name.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        modelSettings += `  <part id="${comp.id}" subtype="normal_part">
   <metadata key="name" value="${safeName}"/>
  </part>
`;
    }
    modelSettings += ` </object>
</config>`;

    zip.folder('Metadata')?.file('model_settings.config', modelSettings);

    return await zip.generateAsync({ type: 'blob' });
}
