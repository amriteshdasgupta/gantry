import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

// All exports share the selected Routed G geometry and explicit theme-safe colors.
const root = new URL('../../', import.meta.url);
const source = await readFile(new URL('docs/images/gantry-icon.svg', root));
const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];
const images = new Map();

for (const size of sizes) {
  images.set(size, await sharp(source).resize(size, size).png().toBuffer());
}

// ICO entries embed PNGs, preserving alpha at every Windows/browser size.
function ico(iconSizes) {
  const header = Buffer.alloc(6 + iconSizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(iconSizes.length, 4);
  let offset = header.length;

  iconSizes.forEach((size, index) => {
    const entry = 6 + index * 16;
    const png = images.get(size);
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = header[entry];
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });

  return Buffer.concat([header, ...iconSizes.map((size) => images.get(size))]);
}

// Modern ICNS representations use PNG payloads, including Retina resolutions.
const types = { 16: 'icp4', 32: 'icp5', 64: 'icp6', 128: 'ic07', 256: 'ic08', 512: 'ic09', 1024: 'ic10' };
const chunks = Object.entries(types).map(([size, type]) => {
  const png = images.get(Number(size));
  const header = Buffer.alloc(8);
  header.write(type);
  header.writeUInt32BE(png.length + 8, 4);
  return Buffer.concat([header, png]);
});
const icnsHeader = Buffer.alloc(8);
icnsHeader.write('icns');
icnsHeader.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);

const outputs = new Map([
  ['desktop/electron/icon.png', images.get(1024)],
  ['desktop/electron/icon.ico', ico([16, 32, 48, 64, 128, 256])],
  ['desktop/electron/icon.icns', Buffer.concat([icnsHeader, ...chunks])],
  ['desktop/src/app/favicon.ico', ico([16, 32, 48])],
  ['desktop/src/app/icon.svg', source],
  ['desktop/public/gantry-icon.svg', source],
]);

for (const [file, contents] of outputs) {
  await writeFile(new URL(file, root), contents);
}

console.log('Generated Gantry PNG, ICO, ICNS, and SVG app icons.');
