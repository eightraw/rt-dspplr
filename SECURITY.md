# Security

Report a vulnerability privately through GitHub:
https://github.com/eightraw/rt-dspplr/security/advisories/new

Do not open a public issue for it.

Only the latest version published on npm receives fixes.

The player runs entirely in the browser: it fetches the audio URLs you give it,
decodes them with the browser's decoder, and starts Web Workers and an
AudioWorklet from `blob:` URLs. It sends nothing anywhere else.
