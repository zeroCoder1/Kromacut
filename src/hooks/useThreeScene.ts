import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export function useThreeScene(
    mountRef: React.RefObject<HTMLDivElement | null>,
    setIsBuilding: (v: boolean) => void
) {
    const rafRef = useRef<number | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const controlsRef = useRef<OrbitControls | null>(null);
    const modelGroupRef = useRef<THREE.Group | null>(null);
    const materialRef = useRef<THREE.MeshStandardMaterial | null>(null);

    useEffect(() => {
        const el = mountRef.current;
        if (!el) return;
        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(el.clientWidth, el.clientHeight);
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 2;
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        el.appendChild(renderer.domElement);
        rendererRef.current = renderer;

        const scene = new THREE.Scene();
        // Set background based on current theme
        const isDarkMode = document.documentElement.classList.contains('dark');
        scene.background = new THREE.Color(isDarkMode ? 0x0b0c0d : 0xffffff);
        sceneRef.current = scene;

        const camera = new THREE.PerspectiveCamera(45, el.clientWidth / el.clientHeight, 0.1, 1000);
        camera.position.set(0, 0.9, 1.8);
        cameraRef.current = camera;

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controlsRef.current = controls;

        // Lights - optimized for MeshStandardMaterial
        const hemiLight = new THREE.HemisphereLight(0xffffff, 0x888888, 1.5);
        scene.add(hemiLight);

        // Strong directional light for definition
        const key = new THREE.DirectionalLight(0xffffff, 1.5);
        key.position.set(2, 3, 1);
        scene.add(key);

        // Container for the model parts
        const modelGroup = new THREE.Group();
        scene.add(modelGroup);
        modelGroupRef.current = modelGroup;

        // Shared material (can be cloned per part if needed, but useful base)
        const material = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            side: THREE.DoubleSide,
            transparent: false,
            metalness: 0.1,
            roughness: 0.9,
        });
        material.vertexColors = false;
        materialRef.current = material;

        // (Optional) Add a placeholder if needed, or just leave empty group until build.
        // For backwards compat with "last mesh" hack:
        try {
            (window as unknown as { __KROMACUT_LAST_MESH?: THREE.Object3D }).__KROMACUT_LAST_MESH =
                modelGroup;
        } catch {
            /* no-op */
        }

        const resize = () => {
            if (!el || !cameraRef.current || !rendererRef.current) return;
            const w = el.clientWidth;
            const h = el.clientHeight;
            rendererRef.current.setSize(w, h);
            cameraRef.current!.aspect = w / h;
            cameraRef.current!.updateProjectionMatrix();
        };
        const ro = new ResizeObserver(resize);
        ro.observe(el);

        // Watch for theme changes
        const updateBackgroundForTheme = () => {
            const isDarkMode = document.documentElement.classList.contains('dark');
            if (sceneRef.current) {
                sceneRef.current.background = new THREE.Color(isDarkMode ? 0x0b0c0d : 0xffffff);
            }
        };

        const themeObserver = new MutationObserver(() => {
            updateBackgroundForTheme();
        });
        themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class'],
        });

        const animate = () => {
            controls.update();
            renderer.render(scene, camera);
            rafRef.current = requestAnimationFrame(animate);
        };
        rafRef.current = requestAnimationFrame(animate);

        // Create an overlay element for build-in-progress messaging
        const overlay = document.createElement('div');
        overlay.style.position = 'absolute';
        overlay.style.left = '0';
        overlay.style.top = '0';
        overlay.style.width = '100%';
        overlay.style.height = '100%';
        overlay.style.display = 'none';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.pointerEvents = 'none';
        overlay.style.zIndex = '10';
        overlay.style.color = '#fff';
        overlay.style.fontFamily = 'sans-serif';
        overlay.style.fontSize = '14px';
        overlay.textContent = 'Building 3D model…';
        el.style.position = el.style.position || 'relative';
        el.appendChild(overlay);

        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            ro.disconnect();
            themeObserver.disconnect();
            controls.dispose();
            material.dispose();
            renderer.dispose();
            if (renderer.domElement.parentNode)
                renderer.domElement.parentNode.removeChild(renderer.domElement);
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            // clear refs
            rendererRef.current = null;
            sceneRef.current = null;
            cameraRef.current = null;
            controlsRef.current = null;
            modelGroupRef.current = null;
            materialRef.current = null;
            setIsBuilding(false);
        };
    }, [mountRef, setIsBuilding]);

    return {
        rendererRef,
        sceneRef,
        cameraRef,
        controlsRef,
        modelGroupRef,
        materialRef,
    } as const;
}

export default useThreeScene;
