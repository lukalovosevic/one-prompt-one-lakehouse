// Render an SVG diagram to PNG at 2x with headless Chrome.
// Usage (from the repo root, playwright comes from .dive-preview):
//   NODE_PATH=.dive-preview/node_modules node docs/diagrams/render_png.mjs docs/dive-runtime.svg docs/dive-runtime.png
import { createRequire } from 'module';
import { readFileSync } from 'fs';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [process.cwd() + '/.dive-preview/node_modules', process.cwd()] }));

const [, , src, dest] = process.argv;
const svg = readFileSync(src, 'utf8');
const w = Number(/width="(\d+)"/.exec(svg)[1]);
const h = Number(/height="(\d+)"/.exec(svg)[1]);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
await page.waitForTimeout(500);
await page.screenshot({ path: dest, clip: { x: 0, y: 0, width: w, height: h } });
await browser.close();
console.log(dest);
