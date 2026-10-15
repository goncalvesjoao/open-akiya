# Coding standards

## Testing

- Prefer tests in a simulated DOM environment, such as jsdom or happy-dom with React Testing Library, for UI behavior that can be verified there. Test observable behavior through accessible queries and user interactions rather than component internals or snapshots alone.
- Use Playwright primarily for the user's main happy path through the integrated application. Keep other UI cases in simulated DOM tests when those tests provide sufficient confidence.
- Add further Playwright coverage when the behavior needs a real browser, such as map rendering or pointer gestures, layout-dependent behavior, or browser-specific APIs that simulated DOM tests cannot verify reliably. The implementer may make this judgment; briefly explain the need in the test or accompanying change description. No separate approval is required.
- Test domain logic, backend APIs, workers, and database behavior at their appropriate non-browser seams. A simulated DOM is a preference for UI tests, not a requirement for every test.
- Preserve required end-to-end acceptance journeys, including the selected-area import journey. Avoid repeating every edge case in Playwright when lower-cost tests already establish the behavior.
