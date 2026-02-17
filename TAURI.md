# Kromacut Native App (Tauri)

Kromacut can now be built as a native Mac application using Tauri, offering better performance than the web version.

## Why Tauri?

- **Smaller app size:** 2-3 MB vs 100+ MB with Electron
- **Better performance:** Uses native macOS WebKit instead of bundling Chromium
- **Lower memory usage:** More efficient resource utilization
- **Native integration:** Better macOS integration and feel

## Prerequisites

- **Rust:** Required for building native components
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  source "$HOME/.cargo/env"
  ```

- **Node.js:** Already required for the web version

## Development

Run the app in development mode:

```bash
npm run tauri:dev
```

This will:
1. Start the Vite dev server on port 5173
2. Launch the native app window
3. Enable hot-reload for fast development

## Building for Production

Build the native Mac app:

```bash
npm run tauri:build
```

This creates two bundles:
1. **Kromacut.app** - Standard macOS application bundle
   - Location: `src-tauri/target/release/bundle/macos/Kromacut.app`
   - Double-click to run
   
2. **Kromacut_0.1.0_aarch64.dmg** - DMG installer
   - Location: `src-tauri/target/release/bundle/dmg/Kromacut_0.1.0_aarch64.dmg`
   - Distributable installer for Apple Silicon Macs

## Configuration

Key Tauri settings in [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json):

- **Window size:** 1400x900 (min: 1000x700) - optimized for the 2-pane layout
- **Bundle identifier:** `com.kromacut.lithophane`
- **Base path:** Automatically switches between `/` (Tauri) and `/Kromacut/` (GitHub Pages)

## Performance Benefits

The native app benefits from:
- **Direct GPU access** for Three.js rendering
- **Native file system** for faster image loading
- **No browser overhead** for better memory management
- **macOS optimization** for M1/M2 chip acceleration

## Web vs Native

Both versions are maintained:
- **Web (GitHub Pages):** `npm run build` → Deploy to https://zeroCoder1.github.io/Kromacut/
- **Native (Tauri):** `npm run tauri:build` → Create Mac app bundle

The codebase is shared; vite.config.ts automatically adapts the base path based on the build target.

## Distribution

### Local Distribution

To share the app:
1. Use the `.dmg` file from `src-tauri/target/release/bundle/dmg/`
2. Recipients can drag Kromacut.app to their Applications folder
3. First launch may require right-click → Open due to Gatekeeper (unsigned app)

### Automated Releases (GitHub)

The project includes a GitHub Action that automatically builds and releases the Mac app:

**To create a new release:**

```bash
# Update version in both files
# 1. package.json - "version": "0.2.0"
# 2. src-tauri/tauri.conf.json - "version": "0.2.0"

# Commit the changes
git add package.json src-tauri/tauri.conf.json
git commit -m "Bump version to 0.2.0"

# Create and push a version tag
git tag v0.2.0
git push origin main
git push origin v0.2.0
```

The workflow will automatically:
1. Build for both Apple Silicon (M1/M2/M3) and Intel Macs
2. Create a GitHub release with the tag name
3. Upload both DMG files as release assets
4. Include installation instructions in the release notes

**Manual trigger:**
You can also trigger the workflow manually from the Actions tab on GitHub.

**Release artifacts:**
- `Kromacut_VERSION_aarch64.dmg` - Apple Silicon (M1/M2/M3)
- `Kromacut_VERSION_x86_64.dmg` - Intel Macs

### Code Signing (Optional)

For signed distribution, you'll need an Apple Developer account and code signing certificate.

## Updating

When the app version changes:
1. Update version in [package.json](package.json)
2. Update version in [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json)
3. Rebuild: `npm run tauri:build`
