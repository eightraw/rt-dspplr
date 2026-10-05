# Publishing RT-DSPPLR

Two packages are released from this repository:

| Package | Folder | |
|---|---|---|
| `@saitdigital/rt-dspplr` | `packages/rt-dspplr` | the player (browser) |
| `@saitdigital/rt-dspplr-prepare` | `packages/rt-dspplr-prepare` | the prepare step (Node); depends on the player for the formats |

**Publish order: the player first, then prepare.** Prepare's dependency
(`"@saitdigital/rt-dspplr": "^0.4.0"`) must resolve on the registry when it is
installed, and its `./format` entry must be the one prepare was tested against.

## Checklist

- Add the release's entries to CHANGELOG.md (one section per package).
- Raise the versions in `packages/rt-dspplr/package.json` and
  `packages/rt-dspplr-prepare/package.json`. When the player's minor version
  changes, raise prepare's dependency range to match (`^0.<minor>.0`).
- A change to the manifest or a binary file follows docs/manifest.md: a new
  optional field needs no new `formatVersion`; anything an older player would
  misread does. Update `MANIFEST_FORMAT_VERSION`, the schema
  (`packages/rt-dspplr/schema/manifest.schema.json`), docs/manifest.md and the
  fixtures in `packages/rt-dspplr/test/fixtures/manifests` together.
- Keep the root LICENSE.md and both packages' LICENSE.md identical, and
  `license: "SEE LICENSE IN LICENSE.md"` in both package.json files.
- Keep THIRD_PARTY_NOTICES.md (player) in step with the vendored code
  (`src/vendor/`); `check-dist` fails when a notice is missing.
- Keep the GitHub repository public: the player's author credit links to it.
- Rubber Band stays optional, external and separately licensed: the build
  checks keep its code and WASM out of the package.
- If the interface changed, record the README animations again (docs/media).

## Validate the artifacts

```bash
npm ci
npm run build       # both packages; the demo typechecks against the built packages
npm run typecheck
npm test            # node tests of both packages
npx playwright install chromium
npm run test:browser
npm run test:package   # both tarballs in isolated consumers; prepare's CLI output played in Chromium
npx publint packages/rt-dspplr
npx publint packages/rt-dspplr-prepare
npx --yes @arethetypeswrong/cli --pack packages/rt-dspplr --profile esm-only --exclude-entrypoints ./styles.css ./manifest.schema.json
npx --yes @arethetypeswrong/cli --pack packages/rt-dspplr-prepare --profile esm-only
npm pack --workspace packages/rt-dspplr --dry-run
npm pack --workspace packages/rt-dspplr-prepare --dry-run
```

Check that the player's tarball includes README.md, LICENSE.md,
THIRD_PARTY_NOTICES.md, the schema, compiled entries, types and styles, and that
prepare's includes README.md, LICENSE.md, `bin/rtd-prepare.mjs` and `dist/`.
Neither may include sources, tests, demo uploads, credentials, local paths or
dependencies. The root README is the GitHub landing page; each package README is
its npm page.

## Publish

```bash
npm publish --workspace packages/rt-dspplr --access public
# wait until `npm view @saitdigital/rt-dspplr@<version> version` answers, then:
npm publish --workspace packages/rt-dspplr-prepare --access public
```

Publish from a clean tree: `npm publish` packs whatever is in the folder, so
unfinished work there would ship. With work in progress, pack the release
commit in a clean copy and publish those tarballs (`npm publish <file>.tgz`),
in the same order.

Then, in this order:

1. Open both package pages on npmjs.com and check that the READMEs show. (The
   page reads it from the package itself; `npm view … readme` may print
   nothing after a workspace publish, which is harmless.)
2. In a new project, install the published player and run its quick start;
   in another, install the published prepare package, run
   `npx rtd-prepare <a wav> out` and play `out/manifest.json` in the player.
3. Tag the published commit `v<version>` for the player and
   `prepare-v<version>` for prepare, push the tags, and write the GitHub
   releases from the CHANGELOG entries.
