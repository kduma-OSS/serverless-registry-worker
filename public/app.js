// Serverless Registry panel: progressive enhancement for the server-rendered pages.
// No dependencies, no inline scripts (CSP `default-src 'self'`). `data-page` on <body> names
// the page; each part below runs only on the pages that need it. Mutations are `fetch` calls to
// /api/v1 authenticated by the session cookie, followed by a reload of the page or by
// `data-api-next`; the forms that create a token are plain form posts.
"use strict";

(function () {
  const page = document.body.getAttribute("data-page") || "";

  // --- Copy buttons copy the code block (or read-only field) next to them. ---------------
  function copy(button) {
    const block = button.closest(".copyable");
    const field = block ? block.querySelector("input, pre code") : null;
    if (!field || !navigator.clipboard) return;
    const text = field instanceof HTMLInputElement ? field.value : field.textContent;
    navigator.clipboard.writeText(text).then(function () {
      const label = button.textContent;
      button.textContent = "Copied";
      setTimeout(function () {
        button.textContent = label;
      }, 1500);
    });
  }

  // --- "Show" buttons switch their input between password and text. ------------------------
  function reveal(button) {
    const input = button.parentElement.querySelector("input");
    if (!input) return;
    const shown = input.type === "text";
    input.type = shown ? "password" : "text";
    button.setAttribute("aria-pressed", shown ? "false" : "true");
    const label = button.getAttribute("aria-label") || "";
    button.setAttribute("aria-label", label.replace(/^(Show|Hide)/, shown ? "Show" : "Hide"));
  }

  document.querySelectorAll("[data-reveal], [data-generate]").forEach(function (button) {
    button.hidden = false;
  });

  // --- Setup: a random secret (48 bytes, base64url), made here and never sent anywhere. ----
  function generate(button) {
    const box = button.closest("[data-secret-gen]");
    let binary = "";
    crypto.getRandomValues(new Uint8Array(48)).forEach(function (byte) {
      binary += String.fromCharCode(byte);
    });
    const value = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    box.querySelector("[data-generated-value]").value = value;
    box.querySelector("[data-generated]").hidden = false;
  }

  // --- Login: show only the fields of the chosen mode. ---------------------------------------
  // Without scripts both sets stay visible; fields of the hidden set are disabled here so they
  // are not submitted.
  function setupLogin(form) {
    function apply() {
      const checked = form.querySelector('input[name="mode"]:checked');
      const mode = checked ? checked.value : "token";
      form.querySelectorAll("[data-login-mode]").forEach(function (pane) {
        const active = pane.getAttribute("data-login-mode") === mode;
        pane.hidden = !active;
        pane.querySelectorAll("input").forEach(function (input) {
          input.disabled = !active;
        });
      });
    }
    form.addEventListener("change", apply);
    apply();
  }

  if (page === "login") document.querySelectorAll("[data-login]").forEach(setupLogin);

  // --- API calls. ------------------------------------------------------------------------
  function api(method, url, body) {
    const headers = { "X-Requested-With": "fetch", Accept: "application/json" };
    const init = { method: method, headers: headers, credentials: "same-origin" };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return fetch(url, init).then(function (response) {
      return response
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          if (!response.ok) {
            throw new Error(data.message || "The request failed (" + response.status + ").");
          }
          return data;
        });
    });
  }

  // A confirmation from `data-confirm`, or the name from `data-confirm-name`: typed into the
  // form's `data-confirm-input`, or into a prompt.
  function confirmed(element) {
    const message = element.getAttribute("data-confirm");
    const name = element.getAttribute("data-confirm-name");
    if (name !== null) {
      const input = element.querySelector("[data-confirm-input]");
      return input ? input.value === name : prompt(message) === name;
    }
    return message === null || confirm(message);
  }

  // After a successful call: the page named by `data-api-next`, or the current one again.
  function after(element) {
    const next = element.getAttribute("data-api-next");
    if (next) location.assign(next);
    else location.reload();
  }

  function showError(form, message) {
    const error = form ? form.querySelector("[data-form-error]") : null;
    if (!error) return alert(message);
    error.textContent = message;
    error.hidden = false;
  }

  // --- Forms sent by fetch: the JSON body of each kind of form. ---------------------------
  function value(form, name) {
    const field = form.querySelector('[name="' + name + '"]');
    return field ? field.value.trim() : "";
  }

  function checked(form, name) {
    const field = form.querySelector('input[name="' + name + '"]:checked');
    return field ? field.value : "";
  }

  function grants(form) {
    const list = [];
    form.querySelectorAll("[data-grant-row]").forEach(function (row) {
      const field = function (name) {
        return row.querySelector('[data-field="' + name + '"]');
      };
      const pkg = field("package").value.trim();
      if (pkg === "") return;
      list.push({
        eco: field("eco").value,
        package: pkg,
        versions: field("versions").value.trim() || "*",
        transitive: field("transitive").checked,
      });
    });
    return list;
  }

  // The roles switched on in the toggles named `roles` of a form.
  function rolesOf(form) {
    return Array.prototype.map.call(
      form.querySelectorAll('input[name="roles"]:checked'),
      function (input) {
        return input.value;
      },
    );
  }

  const BODIES = {
    // `data-grants-field` names the list a form saves (`read_grants`, `publish_grants`, `yank_grants`, `delete_grants`).
    grants: function (form) {
      const body = {};
      body[form.getAttribute("data-grants-field") || "grants"] = grants(form);
      return body;
    },
    roles: function (form) {
      return { roles: rolesOf(form) };
    },
    expire: function (form) {
      const expires = value(form, "expires");
      return expires === "" ? undefined : { expires: expires };
    },
    describe: function (form) {
      // An empty description clears it.
      return { description: value(form, "description") };
    },
  };

  function submit(form) {
    const error = form.querySelector("[data-form-error]");
    if (error) error.hidden = true;
    if (!confirmed(form)) return;
    const build = BODIES[form.getAttribute("data-api-form")];
    const button = form.querySelector('[type="submit"]');
    if (button) button.disabled = true;
    api(
      form.getAttribute("data-api-method"),
      form.getAttribute("data-api-url"),
      build ? build(form) : undefined,
    )
      .then(function () {
        after(form);
      })
      .catch(function (err) {
        if (button) button.disabled = false;
        showError(form, err.message);
      });
  }

  // --- Optional passwords: both fields must match and be long enough. ---------------------
  const MIN_PASSWORD_LENGTH = 12;

  // The field to blame and the message, or null when the password fields are fine.
  function passwordProblem(form) {
    const group = form.querySelector("[data-password]");
    if (!group || group.hidden) return null;
    const first = group.querySelector('[name="password"]');
    const repeat = group.querySelector('[name="password_repeat"]');
    if (first.value === "" && repeat.value === "") return null;
    if (first.value.length < MIN_PASSWORD_LENGTH) {
      return {
        field: first,
        message: "The password must have at least " + MIN_PASSWORD_LENGTH + " characters.",
      };
    }
    if (first.value !== repeat.value) {
      return { field: repeat, message: "The passwords do not match." };
    }
    return null;
  }

  // Reports a password problem on its field; true when the form may be submitted.
  function passwordOk(form) {
    const problem = passwordProblem(form);
    if (!problem) return true;
    problem.field.setCustomValidity(problem.message);
    problem.field.reportValidity();
    return false;
  }

  // Shows the password fields only for the radio choice named by `data-password`
  // (`first_secret:login`, `type:key`); hidden fields are cleared and disabled.
  function syncPassword(form) {
    const group = form.querySelector("[data-password]");
    if (!group) return;
    const rule = group.getAttribute("data-password").split(":");
    const shown = rule[0] === "" || checked(form, rule[0]) === rule[1];
    group.hidden = !shown;
    group.querySelectorAll("input").forEach(function (input) {
      if (!shown) input.value = "";
      input.disabled = !shown;
      input.setCustomValidity("");
    });
  }

  // --- Credential forms: grant rows, the kind, the secret type, "Look up". ---------------
  let grantKeys = 0;

  // A new grant row from the template, with a key of its own (it pairs `grant_transitive`).
  function addGrantRow(button) {
    const template = document.getElementById("grant-row");
    const rows = button.closest("[data-grants]").querySelector("[data-grant-rows]");
    if (!template || !rows) return;
    const row = template.content.cloneNode(true);
    const key = "added-" + ++grantKeys;
    row.querySelector("[data-grant-key]").value = key;
    row.querySelector('[data-field="transitive"]').value = key;
    // In a form with two lists the field names carry the role of the list (`read_grant_eco`).
    const role = button.closest("[data-grants]").getAttribute("data-grant-role");
    if (role && button.closest("form").hasAttribute("data-credential-form")) {
      row.querySelectorAll("[name]").forEach(function (input) {
        input.name = role + "_" + input.name;
      });
    }
    rows.appendChild(row);
  }

  // A group of toggles needs one switched on: the browser refuses an empty one and says why.
  // A group the page hides (the first secret's scope while there is no first secret) is exempt.
  function syncToggles(form) {
    form.querySelectorAll("[data-toggles]").forEach(function (group) {
      const first = group.querySelector("input");
      if (!first) return;
      const none = !group.querySelector("input:checked") && !group.closest("[hidden]");
      first.setCustomValidity(none ? "Switch at least one role on." : "");
    });
  }

  function syncForm(form) {
    let admin = false;
    if (form.querySelector("[data-kind]")) {
      // The roles chosen: which grant lists apply and which scopes the first secret may have.
      const roles = rolesOf(form);
      admin = roles.indexOf("admin") !== -1;
      form.querySelectorAll("[data-grants]").forEach(function (fieldset) {
        fieldset.hidden = roles.indexOf(fieldset.getAttribute("data-grant-role")) === -1;
      });
      form.querySelectorAll("[data-grants-heading]").forEach(function (heading) {
        heading.hidden = roles.indexOf(heading.getAttribute("data-role")) === -1;
      });
      // The scope of the first secret is only asked when there is one and several roles.
      const scope = form.querySelector("[data-scope]");
      if (scope) {
        scope.hidden = roles.length < 2 || checked(form, "first_secret") === "none";
        // Only the roles the credential has can be given to its first secret.
        scope.querySelectorAll("[data-toggle]").forEach(function (item) {
          const offered = roles.indexOf(item.getAttribute("data-toggle")) !== -1;
          item.hidden = !offered;
          const box = item.querySelector("input");
          if (!offered && box) box.checked = false;
        });
      }
    }
    // The first secret of a new credential: an admin always has one (it could not sign in).
    const none = form.querySelector('input[name="first_secret"][value="none"]');
    if (none) {
      const label = form.querySelector('label[for="' + none.id + '"]');
      none.hidden = admin;
      if (label) label.hidden = admin;
      if (admin && none.checked) {
        const login = form.querySelector('input[name="first_secret"][value="login"]');
        if (login) login.checked = true;
        // The script chose it, not the person: remember to go back to None.
        form.setAttribute("data-first-auto", "");
      } else if (!admin && form.hasAttribute("data-first-auto")) {
        form.removeAttribute("data-first-auto");
        none.checked = true;
      }
    }
    const choice = checked(form, "type") || checked(form, "first_secret");
    const gh = form.querySelector("[data-gh-fields]");
    if (gh) gh.hidden = choice !== "gh";
    const login = form.querySelector("[data-login-fields]");
    if (login) login.hidden = choice !== "login";
    syncPassword(form);
    syncToggles(form);
  }

  // "Look up" fills the repository and owner ids of a gh secret from GitHub.
  function lookUp(button) {
    const form = button.closest("form");
    const error = form.querySelector("[data-lookup-error]");
    error.hidden = true;
    button.disabled = true;
    api("GET", "/api/v1/github/repository?name=" + encodeURIComponent(value(form, "repository")))
      .then(function (repository) {
        form.querySelector('[name="repository_id"]').value = repository.id;
        form.querySelector('[name="repository_owner_id"]').value = repository.ownerId;
      })
      .catch(function (err) {
        error.textContent = err.message;
        error.hidden = false;
      })
      .then(function () {
        button.disabled = false;
      });
  }

  // --- Event wiring. ---------------------------------------------------------------------
  document.addEventListener("click", function (event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const copyButton = target.closest("[data-copy]");
    if (copyButton) return copy(copyButton);
    const revealButton = target.closest("[data-reveal]");
    if (revealButton) return reveal(revealButton);
    const generateButton = target.closest("[data-generate]");
    if (generateButton) return generate(generateButton);
    const apiButton = target.closest("button[data-api-url]");
    if (apiButton) {
      if (!confirmed(apiButton)) return;
      apiButton.disabled = true;
      api(apiButton.getAttribute("data-api-method"), apiButton.getAttribute("data-api-url"))
        .then(function () {
          after(apiButton);
        })
        .catch(function (err) {
          apiButton.disabled = false;
          alert(err.message);
        });
      return;
    }
    const lookup = target.closest("[data-gh-lookup]");
    if (lookup) return lookUp(lookup);
    const add = target.closest("[data-add-grant]");
    if (add) return addGrantRow(add);
    const remove = target.closest("[data-remove-grant]");
    if (remove) remove.closest("[data-grant-row]").remove();
  });

  document.addEventListener("submit", function (event) {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form) return;
    if (!passwordOk(form)) {
      event.preventDefault();
      return;
    }
    if (!form.hasAttribute("data-api-form")) return;
    event.preventDefault();
    submit(form);
  });

  document.addEventListener("input", function (event) {
    const target = event.target instanceof HTMLInputElement ? event.target : null;
    if (!target) return;
    // Typing in a password field clears the problem reported on submit.
    const group = target.closest("[data-password]");
    if (group) {
      group.querySelectorAll("input").forEach(function (input) {
        input.setCustomValidity("");
      });
    }
    // A delete button is enabled once the name is typed exactly.
    if (target.hasAttribute("data-confirm-input")) {
      const form = target.closest("form");
      const button = form.querySelector('[type="submit"]');
      button.disabled = target.value !== form.getAttribute("data-confirm-name");
    }
  });

  // --- Secrets: the date and confirm of "Expire" stay hidden until "Expire…" is pressed. -----
  function setupExpire(form) {
    const open = form.querySelector("[data-expire-open]");
    const fields = form.querySelector("[data-expire-fields]");
    const cancel = form.querySelector("[data-expire-cancel]");
    if (!open || !fields) return;
    function show(on) {
      open.hidden = on;
      fields.hidden = !on;
    }
    open.addEventListener("click", function () {
      show(true);
      const input = fields.querySelector("input");
      if (input) input.focus();
    });
    if (cancel) {
      cancel.hidden = false;
      cancel.addEventListener("click", function () {
        show(false);
        open.focus();
      });
    }
    show(false);
  }

  // --- Secrets: the description is text with "Edit"; the form opens in its place. ---------------
  function setupFold(root, names) {
    const open = root.querySelector(names.open);
    const form = root.querySelector(names.form);
    const text = root.querySelector(names.text);
    const cancel = root.querySelector(names.cancel);
    if (!open || !form || !text) return;
    function show(on) {
      form.hidden = !on;
      text.hidden = on;
      open.hidden = on;
    }
    open.addEventListener("click", function () {
      show(true);
      const input = form.querySelector("input");
      if (input) input.focus();
    });
    if (cancel) {
      cancel.hidden = false;
      cancel.addEventListener("click", function () {
        form.reset();
        show(false);
        open.focus();
      });
    }
    show(false);
  }

  function setupDescribe(root) {
    setupFold(root, {
      open: "[data-describe-open]",
      form: "[data-describe-form]",
      text: ".description-text",
      cancel: "[data-describe-cancel]",
    });
  }

  if (page === "credential") document.querySelectorAll("[data-expire-form]").forEach(setupExpire);
  if (page === "credential") document.querySelectorAll("[data-description]").forEach(setupDescribe);

  if (page === "credential" || page === "credential-new") {
    document.addEventListener("change", function (event) {
      const target = event.target instanceof Element ? event.target : null;
      const form = target ? target.closest("form") : null;
      // A first secret picked by hand stays, whatever kind is chosen afterwards.
      if (form && target.getAttribute("name") === "first_secret") {
        form.removeAttribute("data-first-auto");
      }
      if (form) syncForm(form);
    });
    document.querySelectorAll("form").forEach(syncForm);
  }
  document.querySelectorAll("form").forEach(syncPassword);
})();

// --- Package and credential lists: filter by name, ecosystem and group. ----------------------
// The list is complete without JavaScript; the filter bar is rendered hidden, shown here, and
// only hides rows. The ecosystem and group selectors are panels of checkboxes: a row stays when
// it matches any checked ecosystem and any checked group (a group takes in what is inside it);
// none checked: all. A group section without a visible row is hidden, and one with a visible
// row is opened while a filter is active.
(function () {
  const page = document.body.getAttribute("data-page");
  if (page !== "packages" && page !== "credentials") return;
  const bar = document.querySelector("[data-pkg-filter]");
  const list = document.querySelector("[data-pkg-list]");
  if (!bar || !list) return;
  const input = bar.querySelector("[data-filter-name]");
  const multis = Array.prototype.slice.call(bar.querySelectorAll("[data-filter-multi]"));
  const rows = Array.prototype.slice.call(list.querySelectorAll("[data-pkg-row]"));
  const sections = Array.prototype.slice.call(list.querySelectorAll("[data-group-section]"));
  const empty = document.querySelector("[data-pkg-empty]");
  const lead = document.querySelector("[data-pkg-lead]");
  const leadText = lead ? lead.textContent : "";
  const noun = (lead && lead.getAttribute("data-noun")) || "package";

  function options(multi) {
    return Array.prototype.slice.call(multi.querySelectorAll("[data-multi-option]"));
  }

  /** The checked values of the selector of this kind (`eco`, `group`). */
  function checked(kind) {
    const multi = multis.find(function (m) {
      return m.getAttribute("data-filter-multi") === kind;
    });
    if (!multi) return [];
    return options(multi)
      .filter(function (box) {
        return box.checked;
      })
      .map(function (box) {
        return box.value;
      });
  }

  /** What the button of a selector says: "All", the one choice, or how many. */
  function describe(multi) {
    const on = options(multi).filter(function (box) {
      return box.checked;
    });
    const value = multi.querySelector("[data-multi-value]");
    if (!value) return;
    if (on.length === 0) value.textContent = "All";
    else if (on.length === 1) value.textContent = on[0].getAttribute("data-label") || on[0].value;
    else value.textContent = on.length + " selected";
  }

  function apply() {
    const query = input ? input.value.trim().toLowerCase() : "";
    const ecos = checked("eco");
    const groups = checked("group");
    let shown = 0;
    rows.forEach(function (row) {
      const name = row.getAttribute("data-name") || "";
      const within = (row.getAttribute("data-groups") || "").split(" ");
      const visible =
        name.indexOf(query) !== -1 &&
        (ecos.length === 0 || ecos.indexOf(row.getAttribute("data-eco")) !== -1) &&
        (groups.length === 0 ||
          within.some(function (id) {
            return groups.indexOf(id) !== -1;
          }));
      row.hidden = !visible;
      if (visible) shown++;
    });
    const active = query !== "" || ecos.length > 0 || groups.length > 0;
    sections.forEach(function (section) {
      const has = section.querySelector("[data-pkg-row]:not([hidden])") !== null;
      section.hidden = active && !has;
      if (active && has) section.open = true;
    });
    multis.forEach(describe);
    if (empty) empty.hidden = shown > 0;
    if (lead) {
      const total = rows.length;
      lead.textContent = active
        ? "Showing " + shown + " of " + total + " " + noun + (total === 1 ? "" : "s") + "."
        : leadText;
    }
  }

  multis.forEach(function (multi) {
    multi.addEventListener("change", apply);
    const clear = multi.querySelector("[data-multi-clear]");
    if (clear) {
      clear.addEventListener("click", function () {
        options(multi).forEach(function (box) {
          box.checked = false;
        });
        apply();
      });
    }
    // Opening one panel closes the other.
    multi.addEventListener("toggle", function () {
      if (!multi.open) return;
      multis.forEach(function (other) {
        if (other !== multi) other.open = false;
      });
    });
  });
  document.addEventListener("click", function (event) {
    multis.forEach(function (multi) {
      if (multi.open && !multi.contains(event.target)) multi.open = false;
    });
  });
  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    multis.forEach(function (multi) {
      if (!multi.open) return;
      multi.open = false;
      const summary = multi.querySelector("summary");
      if (summary) summary.focus();
    });
  });
  if (input) input.addEventListener("input", apply);
  bar.hidden = false;
  // Browsers restore the input's value and the checked boxes when the user comes back.
  apply();
})();

// --- A link to a group of the list (`#group-<id>`, from a package's breadcrumb) opens it. -----
// The group and the groups above it are opened, however they are collapsed, and scrolled to.
(function () {
  const page = document.body.getAttribute("data-page");
  if (page !== "packages") return;

  function openTarget() {
    const id = window.location.hash.slice(1);
    if (id.indexOf("group-") !== 0) return;
    const target = document.getElementById(id);
    if (!target || !target.hasAttribute("data-group-section")) return;
    for (let node = target; node; node = node.parentElement) {
      if (node.tagName === "DETAILS") node.open = true;
    }
    target.scrollIntoView();
  }

  window.addEventListener("hashchange", openTarget);
  openTarget();
})();

// --- Organize mode of the admin package list: counter, "select all shown", shift-click. ----
// The checkboxes and the form work without JavaScript; this only makes checking many easier.
(function () {
  const form = document.querySelector("[data-organize]");
  if (!form) return;
  const boxes = Array.prototype.slice.call(form.querySelectorAll("[data-select-row]"));
  const count = form.querySelector("[data-select-count]");
  const all = form.querySelector("[data-select-shown]");
  const none = form.querySelector("[data-select-none]");
  let last = -1;

  function shown() {
    return boxes.filter(function (box) {
      const row = box.closest("[data-pkg-row]");
      return !row || !row.hidden;
    });
  }

  function update() {
    if (count) {
      count.textContent = String(
        boxes.filter(function (box) {
          return box.checked;
        }).length,
      );
    }
  }

  boxes.forEach(function (box) {
    box.addEventListener("click", function (event) {
      const visible = shown();
      const at = visible.indexOf(box);
      if (event.shiftKey && last !== -1 && at !== -1) {
        const from = Math.min(last, at);
        const to = Math.max(last, at);
        for (let i = from; i <= to; i++) visible[i].checked = box.checked;
      }
      if (at !== -1) last = at;
      update();
    });
  });
  if (all) {
    all.hidden = false;
    all.addEventListener("click", function () {
      shown().forEach(function (box) {
        box.checked = true;
      });
      update();
    });
  }
  if (none) {
    none.hidden = false;
    none.addEventListener("click", function () {
      boxes.forEach(function (box) {
        box.checked = false;
      });
      update();
    });
  }
  update();
})();

// --- Snippet choosers: alternatives of one group (see `chooser` in src/pages/catalog.ts). ---
// The stylesheet alone switches the panes. This only keeps the choosers of the same group in
// step and remembers the last choice per group for the next page.
(function () {
  const choosers = Array.prototype.slice.call(document.querySelectorAll("[data-chooser]"));
  if (choosers.length === 0) return;
  const KEY = "sreg-chooser:";

  function select(group, variant) {
    choosers.forEach(function (chooser) {
      if (chooser.getAttribute("data-chooser") !== group) return;
      chooser.querySelectorAll(".chooser-radio").forEach(function (radio) {
        if (radio.value === variant) radio.checked = true;
      });
    });
  }

  choosers.forEach(function (chooser) {
    const group = chooser.getAttribute("data-chooser");
    try {
      const saved = window.localStorage.getItem(KEY + group);
      if (saved) select(group, saved);
    } catch {
      // Storage may be unavailable (private mode); the first variant stays selected.
    }
    chooser.addEventListener("change", function (event) {
      const radio = event.target;
      if (!(radio instanceof HTMLInputElement) || !radio.checked) return;
      select(group, radio.value);
      try {
        window.localStorage.setItem(KEY + group, radio.value);
      } catch {
        // Not remembered; nothing else depends on it.
      }
    });
  });
})();
