// report-render.js -- shared, dependency-free markdown/report rendering.
// Loaded by BOTH panel.html (chat bubbles + the inline/global PDF buttons build their
// data from these) and report.html (the standalone tab a PDF export opens). Keeping
// this in one file means the printed report can never silently drift from what the
// chat actually rendered -- there is only one renderMarkdown, not two copies to keep
// in sync.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── Minimal, XSS-safe Markdown ──────────────────────────────────────────────
// Result text comes from the model and from page content, so it is untrusted.
// Everything is HTML-escaped FIRST; the transforms below only ever re-introduce
// a fixed set of known-safe tags, and links are restricted to http/https/mailto.
// No external library (CSP forbids remote scripts anyway) and no innerHTML of raw
// input — the escape happens before any tag is added.
function renderMarkdown(src) {
  const esc = escapeHtml(src == null ? "" : String(src));
  const lines = esc.split(/\r?\n/);
  const out = [];
  let i = 0;

  const inline = (t) => {
    // Pull inline `code` spans out FIRST and park them behind NUL sentinels so the
    // bold/italic/link passes below cannot reinterpret markdown punctuation that is
    // literal inside code (e.g. `**x**` must stay `**x**`, not become bold). The
    // content is restored verbatim at the end. NUL never appears in escaped text.
    const codes = [];
    let s = t.replace(/`([^`]+)`/g, (_, c) => {
      codes.push(c);
      return `\u0000${codes.length - 1}\u0000`;
    });
    s = s
      // bold then italic (bold first so ** is not eaten by *)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_]+)__/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/(^|[^_])_([^_]+)_/g, "$1<em>$2</em>")
      // [text](url) — only safe schemes; href is already HTML-escaped
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, txt, url) => {
        const clean = url.trim();
        return /^(https?:|mailto:)/i.test(clean)
          ? `<a href="${clean}" target="_blank" rel="noopener noreferrer">${txt}</a>`
          : txt;
      });
    // Restore the code spans, now safe from further transformation.
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (/^\s*```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // closing fence
      out.push(`<pre><code>${buf.join("\n")}</code></pre>`);
      continue;
    }
    // Heading
    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) { const n = h[1].length; out.push(`<h${n}>${inline(h[2].trim())}</h${n}>`); i++; continue; }
    // Horizontal rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
    // Blockquote (consecutive). NB: escaping already turned ">" into "&gt;", so the
    // marker to match here is the escaped form, not a literal ">".
    if (/^\s*&gt;\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) { buf.push(inline(lines[i].replace(/^\s*&gt;\s?/, ""))); i++; }
      out.push(`<blockquote>${buf.join("<br>")}</blockquote>`);
      continue;
    }
    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { buf.push(`<li>${inline(lines[i].replace(/^\s*[-*+]\s+/, ""))}</li>`); i++; }
      out.push(`<ul>${buf.join("")}</ul>`);
      continue;
    }
    // Ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { buf.push(`<li>${inline(lines[i].replace(/^\s*\d+[.)]\s+/, ""))}</li>`); i++; }
      out.push(`<ol>${buf.join("")}</ol>`);
      continue;
    }
    // Blank line
    if (/^\s*$/.test(line)) { i++; continue; }
    // Paragraph (gather until blank or block start)
    const buf = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) &&
           !/^\s*(#{1,6}\s|```|&gt;|[-*+]\s|\d+[.)]\s)/.test(lines[i]) &&
           !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i])) {
      buf.push(inline(lines[i])); i++;
    }
    out.push(`<p>${buf.join("<br>")}</p>`);
  }
  return out.join("\n");
}

// Plain-text version for text-to-speech: drop the markdown punctuation so the
// voice does not read "hash", "asterisk asterisk", pipes, backticks, etc.
function stripMarkdown(src) {
  return String(src == null ? "" : src)
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, " "))
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/^\s*([-*_])(\s*\1){2,}\s*$/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\|/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Build a self-contained, print-ready HTML report from the result markdown.
// Styled for paper; no external assets so it renders identically offline.
function buildReportHtml(title, markdown) {
  const dateStr = new Date().toLocaleString();
  const body = renderMarkdown(markdown);
  return `<!doctype html><html><head><meta charset="utf-8">
<title>${escapeHtml(title || "Navy Report")}</title>
<style>
  @page { margin: 20mm 18mm; }
  * { box-sizing: border-box; }
  body { font: 14px/1.65 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         color: #1a1a1a; max-width: 820px; margin: 0 auto; padding: 24px; background: #fff; }
  .rpt-head { border-bottom: 3px solid #6a4cff; padding-bottom: 14px; margin-bottom: 26px; }
  .rpt-brand { font-weight: 700; letter-spacing: .5px; color: #6a4cff; font-size: 13px; text-transform: uppercase; }
  .rpt-title { font-size: 24px; font-weight: 700; margin: 8px 0 4px; line-height: 1.25; }
  .rpt-meta { font-size: 12px; color: #666; }
  h1,h2,h3,h4,h5,h6 { line-height: 1.3; margin: 22px 0 8px; }
  h1 { font-size: 22px; } h2 { font-size: 19px; } h3 { font-size: 16px; }
  p { margin: 10px 0; } ul,ol { margin: 10px 0 10px 24px; } li { margin: 4px 0; }
  a { color: #3a5fcd; word-break: break-word; }
  code { background: #f2f2f7; padding: 1px 5px; border-radius: 4px; font-size: 12.5px;
         font-family: "SFMono-Regular", Consolas, monospace; }
  pre { background: #f6f6fb; border: 1px solid #e3e3ee; border-radius: 8px; padding: 12px;
        overflow-x: auto; } pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid #cfcfe6; margin: 12px 0; padding: 4px 14px; color: #555; }
  hr { border: none; border-top: 1px solid #e0e0e8; margin: 20px 0; }
  .rpt-foot { margin-top: 32px; padding-top: 12px; border-top: 1px solid #e0e0e8;
              font-size: 11px; color: #999; }
  @media print { body { padding: 0; } a { color: #3a5fcd; } }
</style></head>
<body>
  <div class="rpt-head">
    <div class="rpt-brand">Navy · Research Report</div>
    <div class="rpt-title">${escapeHtml(title || "Task Result")}</div>
    <div class="rpt-meta">Generated ${escapeHtml(dateStr)}</div>
  </div>
  ${body}
  <div class="rpt-foot">Produced by Navy — local browser automation.</div>
</body></html>`;
}
