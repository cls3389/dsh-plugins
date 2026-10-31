import { extractPdf, openPdf } from 'clawpdf';

export const DEFAULT_MAX_PAGES = 20;
export const DEFAULT_MAX_TEXT_CHARS = 500_000;
const DEFAULT_DPI = 96;
const DEFAULT_PAGE_MAX_PIXELS = 4_000_000;
const MIN_PAGE_TEXT_CHARS = 80;
const MIN_PAGE_SIDE = 100;

/** Return extracted pages with explicit boundaries, without mixing page order. */
function formatTextPages(pages, maxTextChars) {
  let remaining = maxTextChars;
  let text = '';
  let truncated = false;
  for (const page of pages) {
    const heading = `\n\n【PDF 第 ${page.page} 页 · 文字层】\n`;
    const available = remaining - heading.length;
    if (available <= 0) {
      truncated = true;
      break;
    }
    const body = page.text.slice(0, available) || (page.imageRequired ? '（此页无可用文字层，见随后页面图片。）' : '');
    text += `${heading}${body}`;
    remaining -= heading.length + body.length;
    if (body.length < page.text.length) {
      truncated = true;
      break;
    }
  }
  return { text: text.trim(), truncated };
}

/**
 * Keep every selected page explicit. Clawpdf's auto mode only looks at total
 * document text and silently omits image pages in mixed documents; its shared
 * image budget also degrades later scans. Text and images use separate budgets.
 */
export function assertRenderablePage(image) {
  if (!image) throw new Error('未返回页面图像');
  if (image.width < MIN_PAGE_SIDE || image.height < MIN_PAGE_SIDE) {
    throw new Error(`页面渲染尺寸异常（${image.width}×${image.height}px），拒绝当作有效页面`);
  }
  return image;
}

export async function readPdf(bytes, options = {}) {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const maxTextChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  const dpi = options.dpi ?? DEFAULT_DPI;
  const pageMaxPixels = options.pageMaxPixels ?? DEFAULT_PAGE_MAX_PIXELS;
  const extracted = await extractPdf(bytes, { maxPages, maxTextChars, mode: 'text' });
  const document = await openPdf(bytes);
  try {
    const selectedCount = Math.min(document.pageCount, maxPages);
    const pageNumbers = Array.from({ length: selectedCount }, (_, index) => index + 1);
    const textPages = pageNumbers.map((page) => {
      const text = document.getPageText(page).trim();
      return { page, text, imageRequired: text.length < MIN_PAGE_TEXT_CHARS };
    });
    const formatted = formatTextPages(textPages, maxTextChars);
    const images = [];
    const pageErrors = [];
    const renderedPages = [];
    for (const { page, text } of textPages) {
      // Sparse text on a page normally indicates a scan or a mixed figure page.
      // Pure text pages keep their cheaper text representation; mixed pages are
      // still rendered, so figures cannot silently disappear behind a text layer.
      if (text.length >= MIN_PAGE_TEXT_CHARS) continue;
      renderedPages.push(page);
      try {
        const rendered = await document.extract({
          pages: [page], mode: 'images',
          image: { dpi, maxPixels: pageMaxPixels },
        });
        images.push(assertRenderablePage(rendered.images[0]));
      } catch (error) {
        pageErrors.push({ page, error: `第 ${page} 页图像读取失败：${error?.message ?? error}` });
      }
    }
    return {
      text: formatted.text,
      images,
      totalPages: document.pageCount,
      processedPages: selectedCount,
      renderedPages,
      pageErrors,
      truncated: {
        text: formatted.truncated || extracted.truncated.text,
        images: document.pageCount > maxPages,
      },
    };
  } finally {
    await document.destroy();
  }
}

export function isPdf(fileName, contentType) {
  return contentType === 'application/pdf' || String(fileName).toLowerCase().endsWith('.pdf');
}
