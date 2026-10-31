export interface PdfPageImage {
  page: number;
  width: number;
  height: number;
  bytes: Uint8Array;
  mimeType: 'image/png';
}
export interface PdfReadResult {
  text: string;
  images: PdfPageImage[];
  totalPages: number;
  truncated: { text: boolean; images: boolean };
}
export const DEFAULT_MAX_PAGES: number;
export const DEFAULT_MAX_TEXT_CHARS: number;
export function readPdf(bytes: Uint8Array, options?: { maxPages?: number; maxTextChars?: number }): Promise<PdfReadResult>;
export function isPdf(fileName: string, contentType?: string): boolean;
