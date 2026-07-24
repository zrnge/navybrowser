// report.js — standalone tab opened by exportResultPdf() in panel.js. Reads the
// title/markdown that the panel stashed in chrome.storage.session (under a per-click
// key named in this tab's own ?rid= query param, so two exports fired in quick
// succession can never clobber each other), builds the same report (via
// buildReportHtml from report-render.js, loaded before this file) the chat itself
// would render, replaces this page with it, and prints.
//
// This runs as a genuine top-level tab (not embedded in the side panel), so
// window.print() here is a normal, reliable browser action — the whole point of
// routing the export through a real page instead of an iframe or a blob: URL.
(function () {
  function fail(msg) {
    document.body.textContent = msg;
  }

  const rid = new URLSearchParams(location.search).get("rid");
  if (!rid) {
    fail("Missing report reference. Close this tab and use the PDF button again.");
    return;
  }
  const key = "navyReport_" + rid;

  chrome.storage.session.get([key], (data) => {
    if (chrome.runtime.lastError) {
      fail("Could not load the report: " + chrome.runtime.lastError.message);
      return;
    }
    const entry = data && data[key];
    const title = (entry && entry.title) || "Task Result";
    const markdown = (entry && entry.markdown) || "";
    if (!markdown.trim()) {
      fail("No report data found. Close this tab and use the PDF button again.");
      return;
    }

    const html = buildReportHtml(title, markdown);
    document.open();
    document.write(html);
    document.close();

    // Clear the stashed data now that it has been consumed.
    try { chrome.storage.session.remove([key]); } catch (_) {}

    // Give layout a moment to settle before invoking the browser's print dialog.
    setTimeout(() => { try { window.print(); } catch (_) {} }, 300);
  });
})();
