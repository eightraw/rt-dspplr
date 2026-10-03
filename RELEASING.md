# Publishing RT-DSPPLR

## Checklist

- Raise the version in packages/rt-dspplr/package.json.
- Keep the root and package LICENSE.md identical, and
  `license: "SEE LICENSE IN LICENSE.md"` in package.json.
- Keep the GitHub repository public: the player's author credit links to it.
- Rubber Band stays optional, external and separately licensed: the build
  checks keep its code and WASM out of the package.

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

Install the published version in a new project, then tag the release commit.
