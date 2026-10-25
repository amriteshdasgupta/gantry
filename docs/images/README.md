# Gantry brand artwork

[`gantry-icon.svg`](gantry-icon.svg) is the production app-icon master: the original
[Routed G](../logo-samples/routed-g.svg) geometry in white on violet `#6D28D9`.
The explicit colors remain legible in both light and dark README themes. The
rounded tile is separate from the editable, unmasked symbol in the sample folder.
The artwork is original to Gantry and covered by the repository's MIT license.
See the [research](../icon-research.md) and [selection](../logo-samples/README.md)
for provenance and rationale.

After editing the master, regenerate the committed exports from the repository root:

```sh
npm run icons:generate --prefix desktop
```

The generator uses Sharp and exports a 1024 px PNG for Electron/Linux, a macOS ICNS
with 16–1024 px representations, a Windows ICO with 16–256 px representations,
a 16/32/48 px browser favicon, and SVGs for Next.js metadata and the desktop header.
The app package explicitly includes the runtime PNG; the platform icons are used
by electron-builder. The development app also sets its Dock icon on macOS.

Generated assets are committed, so normal startup and packaging need no image
generation step or remote image service. Rebuild the desktop app to refresh an
installed launcher icon; operating systems may cache icons from older installs.
