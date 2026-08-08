import fs from 'node:fs/promises';

export async function extractPdfDocument(filePath) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const bytes = await fs.readFile(filePath);
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: true,
    isEvalSupported: false
  });
  const pdf = await loadingTask.promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items
      .filter((item) => typeof item.str === 'string' && item.str.trim())
      .map((item) => ({
        text: item.str.trim(),
        x: Number(item.transform?.[4] || 0),
        y: Number(item.transform?.[5] || 0),
        width: Number(item.width || 0),
        height: Number(item.height || 0)
      }));

    const lines = groupIntoLines(items);
    pages.push({
      pageNumber,
      width: viewport.width,
      height: viewport.height,
      lines,
      text: lines.map((line) => line.text).join('\n')
    });
  }

  return {
    pageCount: pdf.numPages,
    pages,
    text: pages.map((page) => page.text).join('\n\f\n')
  };
}

function groupIntoLines(items) {
  const lines = [];
  for (const item of items.sort((left, right) => right.y - left.y || left.x - right.x)) {
    let line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= 2.2);
    if (!line) {
      line = { y: item.y, items: [] };
      lines.push(line);
    }
    line.items.push(item);
  }

  return lines
    .sort((left, right) => right.y - left.y)
    .map((line) => {
      line.items.sort((left, right) => left.x - right.x);
      return { y: line.y, items: line.items, text: joinLayoutItems(line.items) };
    });
}

function joinLayoutItems(items) {
  let output = '';
  let previousEnd = 0;
  for (const item of items) {
    const averageCharacterWidth = item.text.length ? Math.max(2.5, item.width / item.text.length) : 5;
    const gap = Math.max(0, item.x - previousEnd);
    const spaces = output ? Math.max(1, Math.min(24, Math.round(gap / averageCharacterWidth))) : 0;
    output += `${' '.repeat(spaces)}${item.text}`;
    previousEnd = Math.max(previousEnd, item.x + item.width);
  }
  return output.trimEnd();
}
