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

Then, in this order:

1. `npm view @saitdigital/rt-dspplr@<version> readme | head` must print the
   README. The 0.2.0 publish left this field empty and the npm page without a
   README; if it happens again, publish a patch from inside
   `packages/rt-dspplr` (`cd packages/rt-dspplr && npm publish --access public`).
2. Install the published version in a new project and run its quick start.
3. Tag the published commit `v<version>`, push the tag, and write the GitHub
   release from the CHANGELOG entry.
