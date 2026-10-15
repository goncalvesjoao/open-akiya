# Open Akiya

Discover Japan’s vacant homes, freely.

Open Akiya is a local desktop application built with Electron, React and TypeScript. A separate utility process runs imports and owns a SQLite database on your computer. Docker, Supabase and database credentials are unnecessary.

The current app imports **fictional sample listings only**. Select an area, choose **Import sample listings**, inspect progress, and explore saved results on the map. Real sources, address lookup, freshness policies, manual refresh and continuation remain planned; see the [implementation plan](docs/implementation-plan.md).

## Development

Requires Node.js 24+ and npm. Electron includes its own runtime for installed users.

```sh
npm install
npm run dev
```

`dev` uses electron-vite for renderer hot reload and automatic Electron restarts when main-process or worker code changes. The development server binds only to `127.0.0.1:5173`; packaged builds load local files. Preload remains sandboxed in both modes. On Linux you need a graphical desktop and Electron’s system libraries. If your npm policy disables dependency install scripts, permit Electron’s installer and run `node node_modules/electron/install.js` before launching.

```sh
npm test              # SQLite worker/domain tests and React UI tests
npm run test:e2e      # Real Electron import, reload and relaunch journey
npm run lint
npm run format:check
npm run build         # Type checks and renderer/main/preload/worker bundles
npm start             # Preview the last production build
npm run package       # Build an unpacked application in release/
npm run dist          # Build the platform installer (Linux AppImage by default)
```

Electron tests require a graphical session, or a suitable virtual display in CI. They isolate application data in temporary directories and block external network requests. They do not scrape live sources. Installer production/signing and Windows/macOS validation remain release work.

## Local data and background imports

SQLite lives at `open-akiya.sqlite` inside Electron’s per-user application data directory, normally `~/.config/Open Akiya/` on Linux, `~/Library/Application Support/Open Akiya/` on macOS and `%APPDATA%/Open Akiya/` on Windows. The directory name can depend on launch/package metadata; the application name is set explicitly to Open Akiya. Back up the directory while the app is fully quit, including any SQLite journal files.

Closing the window hides it and keeps imports running. Launch Open Akiya again to show the existing window. Choose **Open Akiya → Quit Open Akiya** or **Ctrl/Cmd+Q** to fully exit. Explicit Quit stops new work and preserves committed progress; reopening recovers interrupted imports without duplicating committed effects. Cancelled jobs remain cancelled. Work does not execute while the application is fully exited or the computer is asleep.

Saved listing queries make no collection requests. Map tiles use the OpenStreetMap network service; see [map setup and attribution](docs/synthetic-map.md). No listing dataset is uploaded to a central service.

## Structure

- `src/main/` — Electron lifecycle, utility-process worker, SQLite runtime and fixtures.
- `src/preload/` — isolated renderer API bridge.
- `src/renderer/` — React interface, HTML, styles and UI tests.
- `src/shared/` — process-neutral contracts and geographic validation.
- `out/` — generated main, preload and renderer bundles.
- `e2e/` — integrated Electron journey.
- `docs/` — active specifications, decisions, research and implementation plan.

See the [desktop runtime](docs/desktop-runtime.md) for the current architecture and remaining requirements.

## Contributing

Ideas, bug reports, local akiya sources and contributions are welcome through [GitHub issues](https://github.com/goncalvesjoao/open-akiya/issues). Preserve Japanese originals and source attribution. Source activation must meet the documented access, identity and geographic-reference gates.

## License

[MIT](LICENSE). The project license covers its code; third-party listings and images retain their respective rights.
