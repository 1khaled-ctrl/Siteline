# packages/contracts

Owner: the integrator (Copilot and quality). `docs/contracts.md` is the readable version.

- This package is the source of truth for the shared types and JSON Schemas: sites, stay query and result, layers, missions, copilot tools and store events.
- After 10:30 on Saturday, only the integrator merges changes here, once the affected owners agree in the issue.
- A type and its JSON Schema change together, in the same PR.
- The copilot uses strict tool use, so every tool input schema needs `additionalProperties: false` and a `required` list. The browser validates tool inputs against these schemas before running anything.
- No runtime logic beyond schemas and small type guards.
