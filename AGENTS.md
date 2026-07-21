# pi-graph development notes

- Keep the runtime dependency-free beyond Pi peer packages and Node built-ins.
- Preserve `schemaVersion: 1` compatibility unless a migration path is added.
- Do not use `eval` for routes or templates.
- Do not weaken project trust, mutation confirmation, path validation, or hard limits.
- Agent retries require explicit idempotency review.
- Preserve deliberate context semantics: isolated for independence, thread for private role memory, shared for auditable graph messages.
- A thread key must never execute concurrently or span different working directories.
- New parallel state semantics need deterministic tests.
- Run `npm test`, `npm run validate:examples`, and `npm run check` before release.
- Keep TypeScript erasable and ESM-compatible; avoid enums, namespaces, parameter properties, and unbounded `any`.
