/**
 * Markdown-ish text to a letter-size PDF with pdf-lib: headings, paragraphs,
 * and pipe tables rendered as aligned monospace rows. Good enough for the Box
 * audit trail; the Markdown and JSON are filed alongside it.
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const PAGE = { w: 612, h: 792, margin: 48 };

export async function renderPdf(markdown: string, title: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  const body = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  let page = doc.addPage([PAGE.w, PAGE.h]);
  let y = PAGE.h - PAGE.margin;
  const width = PAGE.w - 2 * PAGE.margin;

  const newPage = () => {
    page = doc.addPage([PAGE.w, PAGE.h]);
    y = PAGE.h - PAGE.margin;
  };
  const line = (text: string, font = body, size = 10, color = rgb(0.1, 0.1, 0.1)) => {
    if (y < PAGE.margin + size) newPage();
    page.drawText(text, { x: PAGE.margin, y, size, font, color });
    y -= size * 1.45;
  };
  const wrap = (text: string, font = body, size = 10): string[] => {
    const words = text.split(/\s+/);
    const out: string[] = [];
    let cur = "";
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) > width && cur) {
        out.push(cur);
        cur = w;
      } else cur = next;
    }
    if (cur) out.push(cur);
    return out;
  };

  const lines = markdown.split("\n");
  let table: string[][] = [];
  const flushTable = () => {
    if (!table.length) return;
    const cols = Math.max(...table.map((r) => r.length));
    const maxChars = Math.floor(width / mono.widthOfTextAtSize("M", 7.5));
    const widths = Array.from({ length: cols }, (_, i) => Math.max(...table.map((r) => (r[i] ?? "").length), 3));
    const total = widths.reduce((a, b) => a + b + 2, 0);
    const scale = total > maxChars ? maxChars / total : 1;
    const w = widths.map((x) => Math.max(3, Math.floor(x * scale)));
    for (const [ri, row] of table.entries()) {
      const cells = row.map((c, i) => {
        const cw = w[i] ?? 3;
        const t = c.length > cw ? `${c.slice(0, Math.max(1, cw - 1))}…` : c;
        return t.padEnd(cw);
      });
      line(cells.join("  "), ri === 0 ? bold : mono, 7.5);
    }
    y -= 6;
    table = [];
  };

  for (const raw of lines) {
    const t = raw.replace(/\*\*/g, "");
    if (t.startsWith("|")) {
      if (/^\|\s*-+/.test(t)) continue;
      table.push(t.slice(1, t.endsWith("|") ? -1 : undefined).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|")));
      continue;
    }
    flushTable();
    if (t.startsWith("# ")) {
      y -= 4;
      for (const l of wrap(t.slice(2), bold, 16)) line(l, bold, 16);
      y -= 4;
    } else if (t.startsWith("## ")) {
      y -= 6;
      for (const l of wrap(t.slice(3), bold, 12)) line(l, bold, 12);
    } else if (t.trim() === "") {
      y -= 5;
    } else {
      for (const l of wrap(t)) line(l);
    }
  }
  flushTable();
  const pages = doc.getPages();
  pages.forEach((p, i) => p.drawText(`${title}  ·  page ${i + 1} of ${pages.length}`, { x: PAGE.margin, y: 24, size: 7.5, font: body, color: rgb(0.45, 0.45, 0.45) }));
  return doc.save();
}
