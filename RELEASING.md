# Releasing

How a new version of `homebridge-smartlife-light` reaches npm and the Homebridge UI.

1. Add a `## X.Y.Z` section at the top of `CHANGELOG.md` and set the same `version` in `package.json`.
2. `npm test` and `npm run lint` must pass (`prepublishOnly` runs them, then builds).
3. Run `npm publish` on the main branch, then `git tag vX.Y.Z && git push --follow-tags`.
4. On GitHub, draft a release for the tag `vX.Y.Z` and paste the `## X.Y.Z` section of the changelog: the Homebridge UI
   shows it as the release notes (it reads the repository found in `homepage` of `package.json`, so the repository must be public).

The package name must stay equal to `PLUGIN_NAME` in `src/settings.ts`: Homebridge uses it to restore cached accessories.
