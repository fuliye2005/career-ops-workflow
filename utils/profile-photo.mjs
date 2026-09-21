import { chromium } from 'playwright';

const DATA_IMAGE_RE = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([a-z0-9+/=\s]+)$/i;

export function parseImageDataUrl(value) {
  const match = String(value || '').trim().match(DATA_IMAGE_RE);
  if (!match) return null;
  return { mime: match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase(), bytes: Buffer.from(match[2], 'base64') };
}

export async function compressImageDataUrl(dataUrl, { maxDimension = 640, quality = 0.82 } = {}) {
  const parsed = parseImageDataUrl(dataUrl);
  if (!parsed?.bytes.length) return null;

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    return await page.evaluate(({ source, maxDimension, quality }) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext('2d');
        if (!context) {
          reject(new Error('Canvas is unavailable'));
          return;
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      image.onerror = () => reject(new Error('Image decoding failed'));
      image.src = source;
    }), {
      source: dataUrl,
      maxDimension,
      quality,
    });
  } finally {
    await browser.close().catch(() => {});
  }
}
