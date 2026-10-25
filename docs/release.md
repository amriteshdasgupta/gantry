# Release process

Gantry follows [semantic versioning](https://semver.org/): `MAJOR.MINOR.PATCH`. Breaking changes to the `gantry.dev/v1` config schema, the HTTP API, or the CLI surface are MAJOR; new features are MINOR; fixes are PATCH. The repository version lives in the root `package.json` and in each workspace package's `package.json` — keep them in lockstep with `packages/server/src/version.ts`, which is what the server reports.

The two release scripts are `scripts/pack-release.mjs` (`npm run release:pack`) and `scripts/check-release.mjs` (`npm run release:verify`).

## Automatic releases from production

Merging a pull request into `production` triggers [the release workflow](../.github/workflows/release.yml). Direct pushes to `production` trigger it too. Prepare the changelog and bump versions (including the lockfile) in the pull request before merging; the workflow uses the root `package.json` version and does not bump it automatically.

The workflow runs on Linux with Node.js 22, installs with `npm ci`, runs typecheck and lint, then runs `release:pack` and `release:verify` (including tests from the packaged archive). It also installs and builds the Linux desktop app. Only after these succeed does it create `v<version>` at the exact triggering commit and publish a GitHub release with generated release notes, the Linux AppImage, `install.sh`, the source/runtime archive, and its SHA-256 sidecar.

Use a new stable `MAJOR.MINOR.PATCH` version for each release. An existing tag fails the workflow rather than overwriting a release. Failed runs before publication can be rerun from the Actions tab. Release runs are serialized and do not cancel an active release.

GitHub Actions must be enabled and the repository must allow the workflow's `GITHUB_TOKEN` to write repository contents. No separate publishing secret is needed.

## Cutting a release manually

1. **Update the changelog.** Add a `## [x.y.z] - YYYY-MM-DD` section to [CHANGELOG.md](../CHANGELOG.md) following Keep a Changelog. Do not release with a full `## [Unreleased]` section.
2. **Bump versions.** Root `package.json`, `packages/shared`, `packages/server`, `packages/cli`, `packages/ui`, and `packages/server/src/version.ts`.
3. **Pack.**

   ```sh
   npm run release:pack
   ```

   Builds everything, then stages **git-tracked files only** — so local state, `tmp/`, data directories and worktrees never get in — plus the two build outputs that are not tracked (`packages/ui/dist` and `packages/server/runners`), and a `VERSION` file. It then creates a reproducible archive (`--sort=name`, zeroed owner/group, fixed mtime) at `dist/gantry-<version>.tar.gz` and writes `dist/gantry-<version>.tar.gz.sha256` with the SHA-256.

4. **Verify.**

   ```sh
   npm run release:verify
   ```

   Exits non-zero on any finding:

   - the archive for the current version exists, unpacks, and installs
   - a content scan over every packaged file for private key material, API-key literals, hardcoded credentials, and home/private paths (`/Users/…`, `/home/…`, `C:\Users\…`, and known private workspace names — docs mentioning the legacy preset label are allowlisted)
   - the test suite passes **from the packaged tree**, not the working tree

   Never publish a release that failed `release:verify`. If the verifier flags something, fix the packaging or the content — never weaken the check.

5. **Tag and push.**

   ```sh
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

    Tags alone do not trigger the release workflow. For a manual release, build and verify release archives locally using the commands above. For an automatic release, merge the prepared version into `production` instead of creating the tag yourself.

6. **Publish the GitHub release.** Attach the archive and its `.sha256` sidecar. Verify a download with:

   ```sh
   shasum -a 256 -c gantry-<version>.tar.gz.sha256
   ```

7. **Announce.** Paste the changelog section into the release notes and link any migration notes ([migrating-from-legacy.md](./migrating-from-legacy.md)) or configuration changes ([configuration.md](./configuration.md)).

## Checklist

- [ ] `CHANGELOG.md` has a section for this version
- [ ] versions bumped in the root, all four workspace packages, and `version.ts`
- [ ] `npm run typecheck` clean
- [ ] `npx vitest run` green
- [ ] `npm run release:pack` produced `dist/gantry-<version>.tar.gz` (+ `.sha256`)
- [ ] `npm run release:verify` passed
- [ ] production release workflow green, or manual tag pushed after local verification
- [ ] archive and checksum published

## After a breaking change

- Document the migration path in the changelog entry, with before/after config snippets when the schema changed.
- Bump `apiVersion` in `packages/shared/src/config/schema.ts` only when old config files cannot be loaded as-is; that is a MAJOR release by definition.
- Numbered SQL migrations are append-only. Never edit an applied migration — add `packages/server/src/db/migrations/NNN_description.sql`.
