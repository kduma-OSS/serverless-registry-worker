// Serverless Registry panel: the message for the person a new secret is for (the one-time
// token and login pages, src/pages/handover.ts). The server renders the message three ways
// (the preview, a mail version with inline styles, plain text) and the same parts as JSON;
// this script copies them, draws the QR code and builds the PDF. The PDF library (jsPDF) is
// loaded from cdnjs, with its integrity hash, only when the PDF is asked for. No inline scripts.
"use strict";

(function () {
  const root = document.querySelector("[data-handover]");
  if (!root) return;

  const JSPDF_URL = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
  const JSPDF_INTEGRITY =
    "sha512-qZvrmS2ekKPF2mSznTQsxqPgnpkI4DNTlrdUmTzrDgektczlKNRRhy5X5AAOnx5S09ydFYWWNSfcEqDTTHgtNA==";
  const QR_MARKER = "%%QR%%";

  const actions = root.querySelector("[data-handover-actions]");
  const status = root.querySelector("[data-handover-status]");
  const htmlSource = root.querySelector("[data-handover-html]");
  const textSource = root.querySelector("[data-handover-text]");
  const dataSource = root.querySelector("[data-handover-blocks]");
  let timer = 0;

  function say(message) {
    if (!status) return;
    status.textContent = message;
    clearTimeout(timer);
    timer = setTimeout(function () {
      status.textContent = "";
    }, 5000);
  }

  // --- The QR code: modules from the rows of "1" and "0" the server computed. ---------------
  function qrCanvas(rows, scale) {
    const quiet = 4;
    const size = (rows.length + quiet * 2) * scale;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, size, size);
    context.fillStyle = "#000000";
    rows.forEach(function (line, y) {
      for (let x = 0; x < line.length; x++) {
        if (line.charAt(x) === "1") {
          context.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
        }
      }
    });
    return canvas;
  }

  function rowsOf(canvas) {
    return canvas.getAttribute("data-handover-qr").split(",");
  }

  root.querySelectorAll("canvas[data-handover-qr]").forEach(function (canvas) {
    const drawn = qrCanvas(rowsOf(canvas), 4);
    canvas.width = drawn.width;
    canvas.height = drawn.height;
    canvas.getContext("2d").drawImage(drawn, 0, 0);
  });

  /** The first QR code of the message as a PNG data URL (a mail client shows no SVG). */
  function qrPng() {
    const canvas = root.querySelector("canvas[data-handover-qr]");
    return canvas ? qrCanvas(rowsOf(canvas), 6).toDataURL("image/png") : "";
  }

  // --- Copying. ----------------------------------------------------------------------------
  function copyWithSelection(node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const done = document.execCommand("copy");
    selection.removeAllRanges();
    return done;
  }

  async function copyRich() {
    const html = htmlSource.value.split(QR_MARKER).join(qrPng());
    const text = textSource.value;
    if (navigator.clipboard && navigator.clipboard.write && window.ClipboardItem) {
      try {
        await navigator.clipboard.write([
          new window.ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([text], { type: "text/plain" }),
          }),
        ]);
        say("Message copied. Paste it into your mail.");
        return;
      } catch {
        // Falls through to copying what is on the page.
      }
    }
    const preview = root.querySelector("[data-handover-preview]");
    say(
      preview && copyWithSelection(preview)
        ? "Message copied. Paste it into your mail."
        : "Could not copy. Select the message and copy it by hand.",
    );
  }

  async function copyPlain() {
    const text = textSource.value;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        say("Plain text copied.");
        return;
      } catch {
        // Falls through to the selection.
      }
    }
    textSource.hidden = false;
    textSource.select();
    const done = document.execCommand("copy");
    textSource.hidden = true;
    say(done ? "Plain text copied." : "Could not copy. Select the message and copy it by hand.");
  }

  // --- The PDF. ----------------------------------------------------------------------------
  function loadJsPdf() {
    return new Promise(function (resolve, reject) {
      if (window.jspdf && window.jspdf.jsPDF) {
        resolve(window.jspdf.jsPDF);
        return;
      }
      const script = document.createElement("script");
      script.src = JSPDF_URL;
      script.integrity = JSPDF_INTEGRITY;
      script.crossOrigin = "anonymous";
      script.referrerPolicy = "no-referrer";
      script.onload = function () {
        if (window.jspdf && window.jspdf.jsPDF) resolve(window.jspdf.jsPDF);
        else reject(new Error("jsPDF did not load"));
      };
      script.onerror = function () {
        reject(new Error("jsPDF could not be loaded"));
      };
      document.head.appendChild(script);
    });
  }

  /** The standard PDF fonts hold Latin-1 only: anything else becomes a question mark. */
  function latin1(value) {
    let out = "";
    for (const ch of String(value)) {
      const code = ch.codePointAt(0);
      out += code === 10 || (code >= 32 && code < 127) || (code >= 160 && code < 256) ? ch : "?";
    }
    return out;
  }

  /** Lines no longer than `limit` characters: breaks long words anywhere (tokens, links). */
  function hardWrap(value, limit) {
    const out = [];
    latin1(value)
      .split("\n")
      .forEach(function (line) {
        if (line === "") out.push("");
        for (let i = 0; i < line.length; i += limit) out.push(line.slice(i, i + limit));
      });
    return out;
  }

  function buildPdf(JsPdf, payload) {
    const doc = new JsPdf({ unit: "mm", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 18;
    const width = pageWidth - margin * 2;
    const PT = 0.3528;
    let y = margin;

    function ensure(height) {
      if (y + height > pageHeight - margin) {
        doc.addPage();
        y = margin;
      }
    }

    function font(face, style, size, color) {
      doc.setFont(face, style);
      doc.setFontSize(size);
      const rgb = color || [34, 34, 34];
      doc.setTextColor(rgb[0], rgb[1], rgb[2]);
      return size * PT * 1.35;
    }

    function paragraph(value, face, style, size, color, after) {
      const lineHeight = font(face, style, size, color);
      doc.splitTextToSize(latin1(value), width).forEach(function (line) {
        ensure(lineHeight);
        doc.text(line, margin, y + size * PT);
        y += lineHeight;
      });
      y += after;
    }

    function monoChars(size, available) {
      font("courier", "normal", size);
      return Math.max(10, Math.floor(available / doc.getTextWidth("M")));
    }

    payload.blocks.forEach(function (block) {
      if (block.t === "title") {
        paragraph(block.text, "helvetica", "bold", 18, [17, 17, 17], 5);
      } else if (block.t === "h") {
        y += 3;
        ensure(12);
        paragraph(block.text, "helvetica", "bold", 12.5, [17, 17, 17], 1.5);
      } else if (block.t === "p") {
        paragraph(block.text, "helvetica", "normal", 10.5, null, 2.5);
      } else if (block.t === "note") {
        paragraph(block.text, "helvetica", "italic", 9.5, [95, 95, 95], 2.5);
      } else if (block.t === "list") {
        block.items.forEach(function (item) {
          const lineHeight = font("helvetica", "normal", 10.5);
          doc.splitTextToSize(latin1(item), width - 6).forEach(function (line, index) {
            ensure(lineHeight);
            if (index === 0) doc.text("-", margin + 1, y + 10.5 * PT);
            doc.text(line, margin + 6, y + 10.5 * PT);
            y += lineHeight;
          });
        });
        y += 2.5;
      } else if (block.t === "kv") {
        const labelWidth = 32;
        block.rows.forEach(function (row) {
          const size = row.mono ? 10 : 10.5;
          const lineHeight = size * PT * 1.35;
          const lines = row.mono
            ? hardWrap(row.value, monoChars(size, width - labelWidth))
            : doc.splitTextToSize(latin1(row.value), width - labelWidth);
          ensure(lineHeight);
          font("helvetica", "bold", 10.5, [85, 85, 85]);
          doc.text(latin1(row.label), margin, y + size * PT);
          font(row.mono ? "courier" : "helvetica", "normal", size, [17, 17, 17]);
          lines.forEach(function (line) {
            ensure(lineHeight);
            doc.text(line, margin + labelWidth, y + size * PT);
            y += lineHeight;
          });
        });
        y += 3;
      } else if (block.t === "code") {
        if (block.title) paragraph(block.title, "helvetica", "normal", 9.5, [95, 95, 95], 0.5);
        const size = 9;
        const lineHeight = size * PT * 1.4;
        const lines = hardWrap(block.text, monoChars(size, width - 6));
        lines.forEach(function (line, index) {
          ensure(lineHeight + (index === 0 ? 2 : 0));
          if (index === 0) y += 1;
          doc.setFillColor(243, 244, 246);
          doc.rect(margin, y - 0.4, width, lineHeight + 0.4, "F");
          font("courier", "normal", size, [17, 17, 17]);
          doc.text(line, margin + 3, y + size * PT);
          y += lineHeight;
        });
        y += 4;
      } else if (block.t === "qr") {
        const side = 44;
        const modules = block.rows.length + 8;
        const cell = side / modules;
        ensure(side + 8);
        doc.setFillColor(255, 255, 255);
        doc.setDrawColor(217, 220, 225);
        doc.rect(margin, y, side, side, "FD");
        doc.setFillColor(0, 0, 0);
        block.rows.forEach(function (line, row) {
          for (let column = 0; column < line.length; column++) {
            if (line.charAt(column) === "1") {
              doc.rect(margin + (column + 4) * cell, y + (row + 4) * cell, cell, cell, "F");
            }
          }
        });
        y += side + 1.5;
        paragraph(block.caption, "helvetica", "normal", 9, [95, 95, 95], 3);
      }
    });
    doc.save(payload.filename);
  }

  async function downloadPdf() {
    let payload;
    try {
      payload = JSON.parse(dataSource.textContent);
    } catch {
      say("Could not read the message.");
      return;
    }
    say("Making the PDF…");
    try {
      const JsPdf = await loadJsPdf();
      buildPdf(JsPdf, payload);
      say("PDF downloaded.");
    } catch {
      say(
        "Could not make the PDF (the library comes from cdnjs.cloudflare.com). Print this page instead: Ctrl+P, Save as PDF.",
      );
    }
  }

  // --- The buttons are inert without the script, so they appear with it. --------------------
  function on(selector, handler) {
    const button = root.querySelector(selector);
    if (button) button.addEventListener("click", handler);
  }
  on("[data-handover-copy]", copyRich);
  on("[data-handover-copy-text]", copyPlain);
  on("[data-handover-pdf]", downloadPdf);
  if (actions) actions.hidden = false;
})();
