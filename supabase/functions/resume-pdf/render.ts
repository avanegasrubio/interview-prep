// Minimal markdown-to-PDF renderer for one-page resumes (Letter size).
// Supports: "# Name", centered header lines under it, "## Section",
// "- bullet", "**bold**" runs, whole-line "*italic*", and [text](url) links
// (printed as text). Uses the built-in Helvetica fonts, so no font files.
import { PDFDocument, PDFFont, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

type Seg = { t: string; b: boolean; i: boolean };
type Word = { t: string; f: PDFFont; join?: boolean }; // join: no space before (e.g. "," after bold text)

function inline(line: string, italic = false): Seg[] {
  const s = line
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<([^>\s]+@[^>\s]+)>/g, "$1");
  const out: Seg[] = [];
  s.split("**").forEach((p, k) => { if (p) out.push({ t: p, b: k % 2 === 1, i: italic }); });
  return out;
}

export async function render(md: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const F = {
    r: await doc.embedFont(StandardFonts.Helvetica),
    b: await doc.embedFont(StandardFonts.HelveticaBold),
    i: await doc.embedFont(StandardFonts.HelveticaOblique),
  };
  const W = 612, H = 792, MX = 46, MT = 40, MB = 40, maxW = W - 2 * MX;
  const ink = rgb(0.07, 0.07, 0.07);
  let page = doc.addPage([W, H]);
  let y = H - MT;

  const fontOf = (s: Seg) => (s.b ? F.b : s.i ? F.i : F.r);
  const clean = (f: PDFFont, s: string) =>
    [...s.replace(/→/g, "->")].filter((ch) => { try { f.encodeText(ch); return true; } catch { return false; } }).join("");
  const need = (h: number) => { if (y - h < MB) { page = doc.addPage([W, H]); y = H - MT; } };

  function para(segs: Seg[], size: number, o: { center?: boolean; indent?: number; bullet?: boolean; gap?: number } = {}) {
    const lh = size * 1.3, indent = o.indent ?? 0, width = maxW - indent, sp = F.r.widthOfTextAtSize(" ", size);
    const words: Word[] = [];
    let prevEndsSpace = true;
    for (const s of segs) {
      const f = fontOf(s), txt = clean(f, s.t);
      txt.split(/\s+/).forEach((w, k) => {
        if (w) words.push({ t: w, f, join: k === 0 && !prevEndsSpace && !/^\s/.test(txt) && words.length > 0 });
      });
      if (txt) prevEndsSpace = /\s$/.test(txt);
    }
    const gapBefore = (w: Word, j: number) => (j && !w.join ? sp : 0);
    const lines: Word[][] = [];
    let cur: Word[] = [], cw = 0;
    for (const w of words) {
      const ww = w.f.widthOfTextAtSize(w.t, size), add = gapBefore(w, cur.length) + ww;
      if (cur.length && !w.join && cw + add > width) { lines.push(cur); cur = [w]; cw = ww; } else { cur.push(w); cw += add; }
    }
    if (cur.length) lines.push(cur);
    lines.forEach((ln, k) => {
      need(lh);
      const lw = ln.reduce((a, w, j) => a + w.f.widthOfTextAtSize(w.t, size) + gapBefore(w, j), 0);
      let x = o.center ? (W - lw) / 2 : MX + indent;
      if (o.bullet && k === 0) page.drawText("•", { x: MX + indent - 9, y: y - size, size, font: F.r, color: ink });
      ln.forEach((w, j) => {
        x += gapBefore(w, j);
        page.drawText(w.t, { x, y: y - size, size, font: w.f, color: ink });
        x += w.f.widthOfTextAtSize(w.t, size);
      });
      y -= lh;
    });
    y -= o.gap ?? 2;
  }

  let inHeader = false, headerLine = 0;
  for (const raw of md.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("# ")) {
      para(inline(line.slice(2)).map((s) => ({ ...s, b: true })), 18, { center: true, gap: 2 });
      inHeader = true; headerLine = 0; continue;
    }
    if (line.startsWith("## ")) {
      inHeader = false; y -= 5; need(24);
      para(inline(line.slice(3).toUpperCase()).map((s) => ({ ...s, b: true })), 10.5, { gap: 0 });
      page.drawLine({ start: { x: MX, y: y + 1 }, end: { x: W - MX, y: y + 1 }, thickness: 0.7, color: rgb(0.2, 0.2, 0.2) });
      y -= 4; continue;
    }
    if (inHeader) {
      para(inline(line), headerLine === 0 ? 11 : 9.5, { center: true, gap: 1 });
      headerLine++; continue;
    }
    if (/^[-*] /.test(line)) { para(inline(line.slice(2)), 9.8, { indent: 12, bullet: true, gap: 1 }); continue; }
    const italic = /^\*[^*].*[^*]\*$/.test(line);
    para(inline(italic ? line.slice(1, -1) : line, italic), 9.8, { gap: 3 });
  }
  return await doc.save();
}
