# Structured Data Diff Checker

Compare two local, bounded JSON-LD graph exports by stable `@id`. It reports added/removed entities and changed types, scalar fields and `@id` relationships. Object-key and unordered-value order do not produce differences. The tool is offline, read-only, zero-dependency Node.js 22+.

```sh
node bin/structured-data-diff-checker.mjs --root examples/pass --before before.json --after after.json --contexts contexts.json
node bin/structured-data-diff-checker.mjs --root examples/fail --before before.json --after after.json --contexts contexts.json
npm run check
```

The first example exits 0 and the second exits 1 with `entity-removed`. A remote context URI is used only if it has an explicit local mapping; it is never fetched. This implements the documented [controlled JSON-LD subset](docs/README.md), not full JSON-LD expansion. Unsupported constructs yield `incomplete` rather than a guessed diff. `src/index.mjs` exports `TOOL_ID` and `compareGraphs`.
