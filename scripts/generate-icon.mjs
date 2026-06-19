import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'icon.svg'));

await sharp(svg, { density: 384 })
	.resize(256, 256)
	.png()
	.toFile(join(root, 'icon.png'));

console.log('Wrote icon.png (256x256)');
