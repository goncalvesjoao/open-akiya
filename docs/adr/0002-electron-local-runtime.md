# Run Open Akiya as an Electron application with SQLite

Open Akiya is intended for people to install and run locally. Use Electron, a React/TypeScript renderer, a TypeScript utility-process worker and an embedded SQLite database to avoid server provisioning and keep one implementation language. Accept Electron’s larger distribution size in exchange for a TypeScript backend.

Keep the renderer sandboxed and context-isolated, expose only validated domain operations through preload, and retain durable job state outside renderer lifetime. Window close hides the application while imports continue; launcher reactivation restores it. Explicit Quit stops execution and preserves committed progress for restart recovery. Running after full application exit requires a separately managed service and is outside this decision.

Preserve local-only storage, request budgets, cancellation, continuation, attribution, location uncertainty and live-source activation gates.
