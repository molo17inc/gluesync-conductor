# Diagnosis contract

Conductor owns this contract. Anything that needs to explain a failure to a user
(the Core Hub UI, support tooling, other services) consumes it; none of them are
imported by Conductor.

| File | What |
| --- | --- |
| `diagnosis.v1.schema.json` | JSON Schema (draft-07) of the `diagnosis` object. `x-gluesync-codes` lists, per code, its owner, resolution codes and the `params` keys it carries. |
| `diagnosis.v1.fixtures.json` | One example payload per code, with fixed values. Use as test data. |

Both are generated from `src/diagnosis/`. After changing a code, a resolution code or
a parameter run `yarn contract:generate`, and commit the result. A test fails when the
committed files are out of date.

## Where it appears

- `GET /connectivity` returns it as `data`.
- Error replies of Conductor requests that depend on MOLO17 services carry it as `diagnosis`
  next to the existing `success` / `error` / `details`.
- Error replies of requests that failed on this install's own files carry it too: `DISK_FULL`
  (HTTP 507, nothing was changed) and `COMPOSE_FILE_CORRUPT` (HTTP 500).

## Rules for consumers

- **Tolerant reader.** Ignore fields you do not know.
- **Unknown `code`.** Show `fallback` (English title, summary and steps) instead of failing.
- **Translate by `code` and `params`, not by `fallback`.** `fallback` is for logs, curl users
  and codes you have not shipped wording for yet.

## Rules for changing it

- Additive only: new codes, new optional fields, new resolution codes.
- Never rename or reuse a code, and never change what a `params` key means.
- Bump `schemaVersion` (and the file names) only for a breaking change.
