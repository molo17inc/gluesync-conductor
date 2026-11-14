# AGENTS.md: gluesync-conductor

Instructions for coding agents working in this repository. The README explains what Conductor does; this file covers how changes and releases are made.

## Build and test

From the repository root: `git submodule update --init`, then `yarn build`, `yarn lint`, `yarn type-check`, `yarn test:coverage`. The sandbox (`sandbox/`, see its README) runs Conductor against a real Docker kit: `node run.mjs up`, `node run.mjs iterate --profiles <profile>`, `node run.mjs down --purge`.

Work goes into `develop` through merge requests.

## Releases

A release is a merge request from `develop` to `main` followed by an annotated tag on `main`. The tag pipeline builds the Linux and Windows (nanoserver ltsc2019 and ltsc2022) images and moves the agent catalog version:

| Tag | Publishes |
|---|---|
| `release-vX.Y.Z` | GA `X.Y.Z` (catalog `latestVersionGA`) |
| `beta-vX.Y.Z.N` | Beta |
| `alpha-vX.Y.Z.N` | Alpha |

Steps for a GA release `X.Y.Z`:

1. **Changelog entry in the Gluesync docs. Every release needs one, with no exception.** Repository `gluesync-docs-contents`, page `src/gluesync/v2.3/modules/gs-modules/pages/conductor-changelog.adoc` (and the `v2.2` copy when the release also targets 2.2 installs): a new `=== X.Y.Z` section at the top with `Released: _<Month D, YYYY>_` set to the release day, and customer-facing bullets (what changes for the user, anything that restarts or recreates a service, new environment variables, fixes). MR to `master`, which is the published site, and a second MR to `develop`. The docs MRs are merged **before or together with** the tag, never after it. A version marked `Unreleased` or `Upcoming` is never tagged.
2. MR `develop` → `main`, merged once its pipeline is green.
3. Annotated tag `release-vX.Y.Z` on the merged `main` commit, message `Conductor X.Y.Z: <one-line summary>`.
4. Check the tag pipeline (`docker_images`, `build_windows_nanoserver_artifacts`, the catalog update) and that `molo17/gluesync-conductor:X.Y.Z` and its `-win-nanoserver-ltsc2019|2022` tags are on Docker Hub.

Beta and alpha tags need no changelog entry.
