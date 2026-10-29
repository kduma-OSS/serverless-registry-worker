// Serverless Registry panel: the grants of a credential as text, next to the rows.
// One grant per line in the shorthand of `sreg` and docs/api.md 5.1,
// `eco:package[:versions[:transitive]]`, so a list can be copied, pasted and kept in a file.
// The rows stay the form: the text is read into rows (and the rows into text) when the view
// is switched and when the form is sent, so the code that saves them does not change. The
// Worker validates the grants as before. No dependencies, no inline scripts.
"use strict";

// The pure part: lines <-> grants. `GrantText` is a global of the classic script, which the
// tests read the same way.
const GrantText = (function () {
  // The first two `:` split `eco:package:versions` (for maven, whose names are
  // `group:artifact`, the first three); a rest that ends in `:true` or `:false` is `transitive`,
  // so versions with colons or commas (`>=1.4, <2`) stay intact. Mirrors `parseGrantShorthand`
  // in src/core/grants.ts and `Grant::parse_shorthand` of the CLI.
  function parseLine(line, ecosystems) {
    const first = line.indexOf(":");
    if (first === -1) {
      throw new Error("expected eco:package[:versions[:transitive]]");
    }
    const eco = line.slice(0, first).trim();
    if (ecosystems.indexOf(eco) === -1) {
      throw new Error("unknown ecosystem " + eco + " (use " + ecosystems.join(", ") + ")");
    }
    const nameColon = eco === "maven" ? line.indexOf(":", first + 1) : first;
    const second = nameColon === -1 ? -1 : line.indexOf(":", nameColon + 1);
    const pkg = (second === -1 ? line.slice(first + 1) : line.slice(first + 1, second)).trim();
    if (pkg === "") throw new Error("missing package");
    let versions = second === -1 ? "*" : line.slice(second + 1);
    let transitive = true;
    const suffix = /:(true|false)$/.exec(versions);
    if (suffix !== null) {
      transitive = suffix[1] === "true";
      versions = versions.slice(0, suffix.index);
    }
    return { eco: eco, package: pkg, versions: versions.trim() || "*", transitive: transitive };
  }

  // Throws an Error naming the line (`line 3: …`); blank lines and `#` comments are skipped.
  function parse(text, ecosystems) {
    const grants = [];
    text.split(/\r?\n/).forEach(function (raw, index) {
      const line = raw.trim();
      if (line === "" || line.charAt(0) === "#") return;
      try {
        grants.push(parseLine(line, ecosystems));
      } catch (err) {
        throw new Error("line " + (index + 1) + ": " + err.message, { cause: err });
      }
    });
    return grants;
  }

  // `transitive` only means something for read credentials, so it is written for those only,
  // and only when it is off (the default is on).
  function format(grants, withTransitive) {
    return grants
      .map(function (g) {
        const line = g.eco + ":" + g.package + ":" + (g.versions || "*");
        return withTransitive && g.transitive === false ? line + ":false" : line;
      })
      .join("\n");
  }

  return { parse: parse, format: format };
})();

// The wiring: only in a browser, only on forms that have grants.
if (typeof document !== "undefined") {
  (function () {
    let keys = 0;

    function pane(fieldset, name) {
      return fieldset.querySelector("[data-grants-" + name + "-pane]");
    }

    // The ecosystems this registry serves: the options of the row template's select.
    function ecosystems() {
      const template = document.getElementById("grant-row");
      const select = template ? template.content.querySelector('[data-field="eco"]') : null;
      return select
        ? Array.prototype.map.call(select.options, function (option) {
            return option.value;
          })
        : [];
    }

    function rowsOf(fieldset) {
      return Array.prototype.map
        .call(fieldset.querySelectorAll("[data-grant-row]"), function (row) {
          const field = function (name) {
            return row.querySelector('[data-field="' + name + '"]');
          };
          return {
            eco: field("eco").value,
            package: field("package").value.trim(),
            versions: field("versions").value.trim() || "*",
            transitive: field("transitive").checked,
          };
        })
        .filter(function (grant) {
          return grant.package !== "";
        });
    }

    // Replaces the rows with one per grant, built from the page's row template.
    function setRows(fieldset, grants) {
      const template = document.getElementById("grant-row");
      const rows = fieldset.querySelector("[data-grant-rows]");
      if (!template || !rows) return;
      rows.textContent = "";
      grants.forEach(function (grant) {
        const row = template.content.cloneNode(true);
        const key = "text-" + ++keys;
        // In the create form (two lists) the field names carry the role of the list.
        const role = fieldset.getAttribute("data-grant-role");
        if (role && fieldset.closest("form").hasAttribute("data-credential-form")) {
          row.querySelectorAll("[name]").forEach(function (input) {
            input.name = role + "_" + input.name;
          });
        }
        row.querySelector("[data-grant-key]").value = key;
        const transitive = row.querySelector('[data-field="transitive"]');
        transitive.value = key;
        transitive.checked = grant.transitive;
        row.querySelector('[data-field="eco"]').value = grant.eco;
        row.querySelector('[data-field="package"]').value = grant.package;
        row.querySelector('[data-field="versions"]').value = grant.versions;
        rows.appendChild(row);
      });
    }

    function showError(fieldset, message) {
      const error = fieldset.querySelector("[data-grants-text-error]");
      error.textContent = message || "";
      error.hidden = !message;
    }

    function inTextMode(fieldset) {
      return !pane(fieldset, "text").hidden;
    }

    // Text -> rows. False (the error shown, the text kept) when a line is not a grant.
    function applyText(fieldset) {
      const text = fieldset.querySelector("[data-grants-text]");
      try {
        setRows(fieldset, GrantText.parse(text.value, ecosystems()));
      } catch (err) {
        showError(fieldset, err.message);
        return false;
      }
      showError(fieldset, "");
      return true;
    }

    function show(fieldset, mode) {
      const toggle = fieldset.querySelector("[data-grants-toggle]");
      if (mode === "text") {
        const read = fieldset.getAttribute("data-grant-kind") === "read";
        fieldset.querySelector("[data-grants-text]").value = GrantText.format(
          rowsOf(fieldset),
          read,
        );
        showError(fieldset, "");
      } else if (!applyText(fieldset)) {
        return;
      }
      pane(fieldset, "text").hidden = mode !== "text";
      pane(fieldset, "rows").hidden = mode === "text";
      toggle.textContent = mode === "text" ? "Edit as rows" : "Edit as text";
    }

    document.addEventListener("click", function (event) {
      const target = event.target instanceof Element ? event.target : null;
      const toggle = target ? target.closest("[data-grants-toggle]") : null;
      if (!toggle) return;
      const fieldset = toggle.closest("[data-grants]");
      show(fieldset, inTextMode(fieldset) ? "rows" : "text");
    });

    // A form sent from the text view: the text becomes the rows first (capturing, so before
    // `app.js` reads them); a line that is not a grant stops the form.
    document.addEventListener(
      "submit",
      function (event) {
        const form = event.target instanceof HTMLFormElement ? event.target : null;
        const fieldset = form ? form.querySelector("[data-grants]") : null;
        if (!fieldset || !pane(fieldset, "text") || !inTextMode(fieldset)) return;
        if (!applyText(fieldset)) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true,
    );

    // The toggle needs scripts, so it is rendered hidden.
    document.querySelectorAll("[data-grants-toggle]").forEach(function (toggle) {
      toggle.hidden = false;
    });
  })();
}
