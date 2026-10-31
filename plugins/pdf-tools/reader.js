import { extractPdf, openPdf } from 'clawpdf';

export const DEFAULT_MAX_PAGES = 20;
export const DEFAULT_MAX_TEXT_CHARS = 500_000;
const DEFAULT_DPI = 96;
const DEFAULT_PAGE_MAX_PIXELS = 4_000_000;

/**
 * Extract a whole PDF once for text, then render selected pages independently.
 * clawpdf's multi-page extractPdf shares one maxPixels budget across the entire
 * document, silently shrinking later pages to thumbnails before dropping them.
 */
export async function readPdf(bytes, options = {}) {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const maxTextChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  const dpi = options.dpi ?? DEFAULT_DPI;
  const pageMaxPixels = options.pageMaxPixels ?? DEFAULT_PAGE_MAX_PIXELS;
  const result = await extractPdf(bytes, { maxPages, maxTextChars, mode: 'text' });
  const text = result.text?.trim() ?? '';
  if (text.length >= 200) {
    return { text, images: [], totalPages: result.pagesProcessed?.length ?? 0, truncated: { text: result.truncated.text, images: false } };
  }

  const document = await openPdf(bytes);
  try {
    const pages = Array.from({ length: Math.min(document.pageCount, maxPages) }, (_, index) => index + 1);
    const images = [];
    for (const page of pages) {
      // A fresh per-page budget prevents earlier pages from degrading later ones.
      const rendered = await document.extract({
        pages: [page], mode: 'images',
        image: { dpi, maxPixels: pageMaxPixels },
      });
      for (const image of rendered.images) images.push(image);
    }
    return {
      text, images, totalPages: document.pageCount,
      truncated: { text: result.truncated.text, images: document.pageCount > maxPages },
    };
  } finally {
    await document.destroy();
  }
}

export function isPdf(fileName, contentType) {
  return contentType === 'application/pdf' || String(fileName).toLowerCase().endsWith('.pdf');
}
