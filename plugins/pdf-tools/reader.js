import { extractPdf } from 'clawpdf';

export const DEFAULT_MAX_PAGES = 20;
export const DEFAULT_MAX_TEXT_CHARS = 500_000;

/** Pure PDF parser shared by pdf_read and Feishu automatic attachment reading. */
export async function readPdf(bytes, options = {}) {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const maxTextChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  const result = await extractPdf(bytes, { maxPages, maxTextChars });
  return {
    text: result.text?.trim() ?? '',
    images: result.images ?? [],
    totalPages: result.pagesProcessed?.length ?? result.images?.length ?? 0,
    truncated: result.truncated ?? { text: false, images: false },
  };
}

export function isPdf(fileName, contentType) {
  return contentType === 'application/pdf' || String(fileName).toLowerCase().endsWith('.pdf');
}
