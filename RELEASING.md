# Publishing RT-DSPPLR

## Checklist

- Add the release's entry to CHANGELOG.md.
- Raise the version in packages/rt-dspplr/package.json.
- Keep the root and package LICENSE.md identical, and
  `license: "SEE LICENSE IN LICENSE.md"` in package.json.
- Keep the GitHub repository public: the player's author credit links to it.
- Rubber Band stays optional, external and separately licensed: the build
  checks keep its code and WASM out of the package.
- If the interface changed, record the README animations again (docs/media).

## Validate the artifact

```bash
npm ci
npm run build       # the demo typechecks against the built package
npm run typecheck
npm test
npx playwright install chromium
npm run test:browser
npm run test:package
npm pack --workspace packages/rt-dspplr --dry-run
```

Check that the tarball includes README.md, LICENSE.md, compiled
entries, types and styles, and excludes demo uploads, credentials and dependencies.
The root README is the GitHub landing page; the package README is the npm page.

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
2. Install the published version in a new project and run its quick start.
3. Tag the published commit `v<version>`, push the tag, and write the GitHub
   release from the CHANGELOG entry.
