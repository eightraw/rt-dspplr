# Publishing RT-DSPPLR

One package is released from this repository:

| Package | Folder | |
|---|---|---|
| `@saitdigital/rt-dspplr` | `packages/rt-dspplr` | the player (browser), and the prepare step for long recordings: the `./prepare` entry and the `rtd-prepare` CLI (Node) |

The player and the prepare step share one version: a recording prepared with a
version plays in the same version, and the manifest's `formatVersion` says when a
newer player needs a recording prepared again.

## Checklist

- Add the release's entries to CHANGELOG.md.
- Raise the version in `packages/rt-dspplr/package.json`.
- A change to the manifest or a binary file follows docs/manifest.md: a new
  optional field needs no new `formatVersion`; anything an older player would
  misread does. Update `MANIFEST_FORMAT_VERSION`, the schema
  (`packages/rt-dspplr/schema/manifest.schema.json`), docs/manifest.md and the
  fixtures in `packages/rt-dspplr/test/fixtures/manifests` together.
- Keep the root LICENSE.md and the package's LICENSE.md identical, and
  `license: "SEE LICENSE IN LICENSE.md"` in package.json.
- Keep THIRD_PARTY_NOTICES.md in step with the vendored code (`src/vendor/`,
  and the WebAssembly embedded in `./prepare`: pffft, dr_libs, libopus, libogg,
  opusfile); `check-dist` fails when one of these notices is missing.
- Keep the GitHub repository public: the player's author credit links to it.
- Rubber Band stays optional, external and separately licensed: the build
  checks keep its code and WASM out of the package.
- If the interface changed, record the README animations again (docs/media).

## Validate the artifact

```bash
npm ci
npm run build       # the package (player, then ./prepare); the demo typechecks against it
npm run typecheck   # after the build: ./prepare is checked against the built declarations
npm test            # node tests of the player and of ./prepare
npx playwright install chromium
npm run test:browser
npm run test:package   # the tarball in isolated consumers; the installed CLI's output played in Chromium
npx publint packages/rt-dspplr
npx --yes @arethetypeswrong/cli --pack packages/rt-dspplr --profile esm-only --exclude-entrypoints ./styles.css ./manifest.schema.json
npm pack --workspace packages/rt-dspplr --dry-run
```

Check that the tarball includes README.md, PREPARE.md, LICENSE.md,
THIRD_PARTY_NOTICES.md, the schema, compiled entries (`dist/`, `dist/prepare/`),
types, styles and `bin/rtd-prepare.mjs`, and no sources, tests, demo uploads,
credentials, local paths or dependencies. The root README is the GitHub landing
page; the package README is its npm page.

## Publish

```bash
npm publish --workspace packages/rt-dspplr --access public
```

Publish from a clean tree: `npm publish` packs whatever is in the folder, so
unfinished work there would ship. With work in progress, pack the release
commit in a clean copy and publish that tarball (`npm publish <file>.tgz`).

Then, in this order:

1. Open the package page on npmjs.com and check that the README shows. (The
   page reads it from the package itself; `npm view … readme` may print
   nothing after a workspace publish, which is harmless.)
2. In a new project, install the published package and run its quick start;
   in another (Node), install it, run `npx rtd-prepare <a wav> out` and play
   `out/manifest.json` in the player.
3. Tag the published commit `v<version>`, push the tag, and write the GitHub
   release from the CHANGELOG entry.
