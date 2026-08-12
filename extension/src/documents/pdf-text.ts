import { createLogger } from '@/shared/logger';

const log = createLogger('documents/pdf-text');

/**
 * Résumé text extraction (ARCHITECTURE.md §7: "`pdfjs-dist` + LLM structuring —
 * extract text, then LLM → `Profile` fields").
 *
 * Runs in the options page, not the service worker: pdf.js needs a Worker, and
 * spawning one from inside an MV3 service worker is not supported. The options
 * page is an ordinary extension document, so the worker loads from a bundled
 * local file — no remote code, consistent with the CSP.
 *
 * The extracted text is also what grounds answer drafts (§3.6), so it is stored
 * on the résumé's `DocumentRef` rather than thrown away after parsing.
 */

/** Beyond this a résumé is a portfolio; the tail adds prompt cost, not signal. */
export const MAX_RESUME_CHARS = 40_000;

/** Guard against a pathological or malicious document. */
const MAX_PAGES = 30;

export interface ExtractedText {
  text: string;
  pages: number;
  truncated: boolean;
}

export async function extractPdfText(bytes: Uint8Array): Promise<ExtractedText> {
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.default;

  // `getDocument` transfers the buffer, so hand it a copy the caller still owns.
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const document = await task.promise;

  try {
    const pageCount = Math.min(document.numPages, MAX_PAGES);
    const pages: string[] = [];

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim(),
      );
      page.cleanup();
    }

    const joined = pages.filter(Boolean).join('\n\n');
    const truncated = joined.length > MAX_RESUME_CHARS;

    log.info(`extracted ${joined.length} characters from ${pageCount} page(s)`);
    return {
      text: truncated ? joined.slice(0, MAX_RESUME_CHARS) : joined,
      pages: pageCount,
      truncated: truncated || document.numPages > MAX_PAGES,
    };
  } finally {
    // Teardown lives on the loading task, not the document proxy — releasing it
    // is what terminates the pdf.js worker.
    await task.destroy();
  }
}

/** A .txt or .md résumé needs no PDF machinery. */
export function extractPlainText(bytes: Uint8Array): ExtractedText {
  const text = new TextDecoder().decode(bytes).replace(/\r\n/g, '\n').trim();
  return {
    text: text.slice(0, MAX_RESUME_CHARS),
    pages: 1,
    truncated: text.length > MAX_RESUME_CHARS,
  };
}

export async function extractDocumentText(
  bytes: Uint8Array,
  mimeType: string,
  filename: string,
): Promise<ExtractedText | undefined> {
  if (mimeType === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')) {
    return extractPdfText(bytes);
  }
  if (mimeType.startsWith('text/') || /\.(txt|md)$/i.test(filename)) {
    return extractPlainText(bytes);
  }
  // .docx is a zip of XML; not worth a dependency until someone asks for it.
  log.info(`no text extractor for ${mimeType || filename}`);
  return undefined;
}
