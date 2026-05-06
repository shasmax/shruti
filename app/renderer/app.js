/* shruti renderer — vanilla JS app
 *
 * Uses the API exposed by preload.js as `window.shruti`. No bundler,
 * no React; this UI is small enough that vanilla is the cheapest
 * thing that won't fight us during packaging.
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  meetings: [],
  selectedId: null,
  recording: false,
  notesTimer: null,
  titleTimer: null,
  popoverTargetId: null,
  moveTargetId: null,
  /** Active folder filter: null = all, "" = uncategorized only, string = that folder name */
  activeFolder: null,
};

const ALL_FOLDER = "__all__";
const NONE_FOLDER_KEY = "__none__"; // matches existing constant for move dialog

// ---- bootstrap ------------------------------------------------------------

window.addEventListener("DOMContentLoaded", async () => {
  await applyThemeFromSettings();
  await applySidebarStateFromSettings();
  bindEvents();
  await checkRecordingStatus();
  await refreshList();
  window.shruti.recording.onStatus((evt) => onRecordingStatus(evt));
});

async function applySidebarStateFromSettings() {
  const s = await window.shruti.settings.get();
  if (s.sidebarCollapsed) {
    document.getElementById("app").classList.add("sidebar-collapsed");
  }
}

async function toggleSidebar() {
  const app = document.getElementById("app");
  const collapsed = app.classList.toggle("sidebar-collapsed");
  await window.shruti.settings.set({ sidebarCollapsed: collapsed });
}

// ---- theme ----------------------------------------------------------------

const THEMES = ["dark", "light", "system"];

async function applyThemeFromSettings() {
  const s = await window.shruti.settings.get();
  const theme = s.theme && THEMES.includes(s.theme) ? s.theme : "light";
  document.documentElement.setAttribute("data-theme", theme);
}

function applyTheme(theme) {
  if (!THEMES.includes(theme)) theme = "light";
  document.documentElement.setAttribute("data-theme", theme);
}

// ---- Custom modal (replaces native alert/confirm/prompt) -----------

/**
 * Show a modal dialog. Returns a Promise that resolves with:
 *   - alert:   undefined when dismissed
 *   - confirm: true on confirm, false on cancel
 *   - prompt:  string on confirm, null on cancel
 *
 * `kind` is one of "alert" | "confirm" | "prompt". `opts.danger` styles
 * the confirm button in the accent color (used for destructive actions).
 */
function showModal(kind, opts = {}) {
  return new Promise((resolve) => {
    const dlg = $("#modal");
    const title = $("#modal-title");
    const message = $("#modal-message");
    const input = $("#modal-input");
    const cancelBtn = $("#modal-cancel");
    const confirmBtn = $("#modal-confirm");

    title.textContent = opts.title ?? "";
    title.classList.toggle("hidden", !opts.title);
    message.textContent = opts.message ?? "";
    message.classList.toggle("hidden", !opts.message);

    if (kind === "prompt") {
      input.classList.remove("hidden");
      input.value = opts.defaultValue ?? "";
      input.placeholder = opts.placeholder ?? "";
    } else {
      input.classList.add("hidden");
    }

    const isAlert = kind === "alert";
    cancelBtn.classList.toggle("hidden", isAlert);
    cancelBtn.textContent = opts.cancelLabel ?? "Cancel";
    confirmBtn.textContent = opts.confirmLabel ?? "OK";
    confirmBtn.classList.toggle("danger", Boolean(opts.danger));
    dlg.dataset.variant = opts.danger ? "danger" : "default";

    let settled = false;
    const cleanup = () => {
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
      dlg.removeEventListener("close", onClose);
      input.removeEventListener("keydown", onKey);
      dlg.close();
    };
    const onCancel = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(kind === "prompt" ? null : kind === "confirm" ? false : undefined);
    };
    const onConfirm = () => {
      if (settled) return;
      settled = true;
      const value = kind === "prompt" ? input.value : true;
      cleanup();
      resolve(kind === "prompt" ? value : kind === "confirm" ? true : undefined);
    };
    const onClose = () => {
      if (settled) return;
      onCancel();
    };
    const onKey = (e) => {
      if (e.key === "Enter") onConfirm();
      else if (e.key === "Escape") onCancel();
    };

    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
    dlg.addEventListener("close", onClose);
    input.addEventListener("keydown", onKey);

    dlg.showModal();
    if (kind === "prompt") {
      requestAnimationFrame(() => input.focus());
    } else {
      requestAnimationFrame(() => confirmBtn.focus());
    }
  });
}

const ui = {
  alert: (message, opts = {}) => showModal("alert", { message, confirmLabel: "OK", ...opts }),
  confirm: (message, opts = {}) => showModal("confirm", { message, ...opts }),
  prompt: (message, defaultValue = "", opts = {}) =>
    showModal("prompt", { message, defaultValue, ...opts }),
};

// ---- Custom dropdown component -------------------------------------------

function bindDropdown(rootEl, opts = {}) {
  if (!rootEl) return;
  const trigger = rootEl.querySelector(".dropdown-trigger");
  const menu = rootEl.querySelector(".dropdown-menu");
  const label = rootEl.querySelector(".dropdown-label");

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = rootEl.classList.contains("open");
    // Close any other open dropdowns first
    document.querySelectorAll(".dropdown.open").forEach((d) => {
      if (d !== rootEl) closeDropdown(d);
    });
    if (isOpen) closeDropdown(rootEl);
    else openDropdown(rootEl);
  });

  menu.querySelectorAll(".dropdown-option").forEach((opt) => {
    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      const value = opt.dataset.value;
      setDropdownValue(rootEl, value);
      closeDropdown(rootEl);
      if (opts.onChange) opts.onChange(value);
    });
  });
}

function openDropdown(rootEl) {
  rootEl.classList.add("open");
  // Decide whether to open upward — if there's not enough room below
  // the trigger inside the viewport, flip up.
  rootEl.classList.remove("open-up");
  const trigger = rootEl.querySelector(".dropdown-trigger");
  const rect = trigger.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom;
  const spaceAbove = rect.top;
  // The menu can be up to 240px tall (matches .dropdown-menu max-height).
  if (spaceBelow < 260 && spaceAbove > spaceBelow) {
    rootEl.classList.add("open-up");
  }
  rootEl.querySelector(".dropdown-menu").classList.remove("hidden");
}
function closeDropdown(rootEl) {
  rootEl.classList.remove("open");
  rootEl.querySelector(".dropdown-menu").classList.add("hidden");
}
function getDropdownValue(rootEl) {
  return rootEl.dataset.value;
}
function setDropdownValue(rootEl, value) {
  rootEl.dataset.value = value;
  const opt = rootEl.querySelector(`.dropdown-option[data-value="${CSS.escape(value)}"]`);
  if (opt) {
    rootEl.querySelectorAll(".dropdown-option.selected").forEach((o) =>
      o.classList.remove("selected"),
    );
    opt.classList.add("selected");
    const titleEl = opt.querySelector(".opt-title");
    rootEl.querySelector(".dropdown-label").textContent =
      titleEl ? titleEl.textContent : opt.textContent;
  }
}

function bindEvents() {
  $("#record-btn").addEventListener("click", toggleRecord);
  $("#settings-btn").addEventListener("click", openSettings);

  // Custom dropdowns
  bindDropdown($("#theme-dropdown"), {
    onChange: (val) => applyTheme(val),
  });
  bindDropdown($("#model-dropdown"), {
    onChange: (val) => {
      const customInput = $("#openrouter-model");
      if (val === "__custom__") {
        customInput.classList.remove("hidden");
        customInput.focus();
      } else {
        customInput.classList.add("hidden");
      }
    },
  });

  // Click-outside closes any open dropdown
  document.addEventListener("click", (e) => {
    document.querySelectorAll(".dropdown.open").forEach((d) => {
      if (!d.contains(e.target)) closeDropdown(d);
    });
  });
  $("#settings-save").addEventListener("click", saveSettings);
  $("#settings-cancel").addEventListener("click", async () => {
    // Revert any live theme preview to the saved value
    await applyThemeFromSettings();
    $("#settings-dialog").close();
  });

  // Pressing Enter in any field would otherwise dismiss the <dialog>
  // without saving (form method="dialog" behavior). Catch the submit
  // and route it through saveSettings so Enter saves + closes.
  document.querySelector("#settings-dialog form").addEventListener("submit", (e) => {
    e.preventDefault();
    saveSettings();
  });

  $("#new-folder-btn").addEventListener("click", newFolder);
  $("#collapse-btn").addEventListener("click", toggleSidebar);

  // Suggestion cards on empty state
  $("#sg-record")?.addEventListener("click", toggleRecord);
  $("#sg-folder")?.addEventListener("click", newFolder);
  $("#sg-settings")?.addEventListener("click", openSettings);

  // Popover menu actions
  $$(".popover-item").forEach((btn) =>
    btn.addEventListener("click", (e) => onPopoverAction(btn.dataset.action, e)),
  );
  document.addEventListener("click", (e) => {
    if (!$("#popover").contains(e.target) && !e.target.closest(".meeting-item-menu")) {
      hidePopover();
    }
  });

  // Move dialog
  $("#move-cancel").addEventListener("click", () => $("#move-dialog").close());
  $("#move-save").addEventListener("click", confirmMove);
  document.querySelector("#move-dialog form").addEventListener("submit", (e) => {
    e.preventDefault();
    confirmMove();
  });
  $("#delete-btn").addEventListener("click", () => {
    if (state.selectedId) deleteMeeting(state.selectedId);
  });
  $("#resummarize-btn").addEventListener("click", resummarize);

  $("#meeting-title").addEventListener("input", (e) => {
    if (!state.selectedId) return;
    clearTimeout(state.titleTimer);
    state.titleTimer = setTimeout(async () => {
      await window.shruti.meetings.update(state.selectedId, { title: e.target.value });
      await refreshList(state.selectedId);
    }, 400);
  });

  $("#notes-area").addEventListener("input", (e) => {
    if (!state.selectedId) return;
    clearTimeout(state.notesTimer);
    state.notesTimer = setTimeout(async () => {
      await window.shruti.meetings.update(state.selectedId, { notes: e.target.value });
    }, 400);
  });

  $$(".tab").forEach((tab) =>
    tab.addEventListener("click", () => switchTab(tab.dataset.tab)),
  );
}

// ---- recording ------------------------------------------------------------

async function checkRecordingStatus() {
  const s = await window.shruti.recording.status();
  state.recording = s.inProgress;
  setRecordButton();
}

async function toggleRecord() {
  if (state.recording) {
    setStatus("stopping…");
    try {
      const meeting = await window.shruti.recording.stop();
      state.recording = false;
      setRecordButton();
      await refreshList(meeting.id);
    } catch (err) {
      await ui.alert(err.message, { title: "Couldn't stop recording" });
      state.recording = false;
      setRecordButton();
    }
  } else {
    try {
      await window.shruti.recording.start();
      state.recording = true;
      setRecordButton();
      setStatus("recording…");
    } catch (err) {
      await ui.alert(err.message, { title: "Couldn't start recording" });
    }
  }
}

function setRecordButton() {
  const btn = $("#record-btn");
  if (state.recording) {
    btn.textContent = "■ Stop recording";
    btn.classList.add("recording");
  } else {
    btn.textContent = "● Record meeting";
    btn.classList.remove("recording");
    setStatus(null);
  }
}

function setStatus(msg) {
  const el = $("#recording-status");
  if (!msg) {
    el.classList.add("hidden");
    el.textContent = "";
  } else {
    el.classList.remove("hidden");
    el.textContent = msg;
  }
}

function onRecordingStatus(evt) {
  if (!evt) return;
  const e = typeof evt === "string" ? { event: evt } : evt;
  switch (e.event) {
    case "started": setStatus("recording…"); break;
    case "stopping": setStatus("stopping…"); break;
    case "stopped": setStatus("transcribing…"); break;
    case "transcribing": setStatus("transcribing…"); break;
    case "transcribed": setStatus("summarizing…"); break;
    case "summarizing": setStatus("summarizing…"); break;
    case "summary_error": setStatus(`summary error: ${e.message}`); break;
    case "saved": setStatus(null); break;
    default: /* keep current status */ break;
  }
}

// ---- meetings list --------------------------------------------------------

async function refreshList(selectId) {
  state.meetings = await window.shruti.meetings.list();
  renderList();
  if (selectId) await selectMeeting(selectId);
  else if (state.selectedId && !state.meetings.find((m) => m.id === state.selectedId)) {
    state.selectedId = null;
    showEmpty();
  }
}

function renderList() {
  renderFolderPills();

  const ul = $("#meetings-list");
  if (state.meetings.length === 0) {
    ul.innerHTML = `<div class="empty">no meetings yet</div>`;
    return;
  }

  // Apply active folder filter
  const filtered = state.meetings.filter((m) => {
    if (state.activeFolder === null) return true;        // All
    if (state.activeFolder === "") return !m.folder;     // No folder
    return m.folder === state.activeFolder;
  });

  if (filtered.length === 0) {
    ul.innerHTML = `<div class="empty">no meetings in this folder</div>`;
    return;
  }

  ul.innerHTML = filtered.map(meetingItemHtml).join("");

  // Wire interactions
  $$(".meeting-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".meeting-item-menu")) return;
      selectMeeting(el.dataset.id);
    });
  });
  $$(".meeting-item-menu").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      showPopover(btn);
    }),
  );
}

function meetingItemHtml(m) {
  const date = new Date(m.created_at);
  const day = date.toLocaleDateString([], { month: "short", day: "numeric" });
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const dur = `${Math.round(m.duration_s / 60)}m`;
  return `
    <div class="meeting-item ${m.id === state.selectedId ? "selected" : ""}" data-id="${m.id}">
      <div class="meeting-item-title">${escapeHtml(m.title)}</div>
      <div class="meeting-item-meta">${day} · ${time} · ${dur}</div>
      <button class="meeting-item-menu" data-id="${m.id}" title="Actions">⋯</button>
    </div>
  `;
}

function renderFolderPills() {
  const el = $("#folder-pills");
  const folderCounts = new Map();
  let uncategorizedCount = 0;
  for (const m of state.meetings) {
    if (m.folder) folderCounts.set(m.folder, (folderCounts.get(m.folder) ?? 0) + 1);
    else uncategorizedCount++;
  }
  const folderNames = Array.from(folderCounts.keys()).sort((a, b) => a.localeCompare(b));

  // Always show "All". Show "No folder" only if there are uncategorized.
  // Show each folder pill. Empty if no meetings yet.
  const pills = [];
  pills.push({ key: "__all__", label: "All", count: state.meetings.length, value: null });
  if (uncategorizedCount > 0) {
    pills.push({ key: "__none__", label: "No folder", count: uncategorizedCount, value: "" });
  }
  for (const f of folderNames) {
    pills.push({ key: f, label: f, count: folderCounts.get(f), value: f });
  }

  if (pills.length <= 1 && state.meetings.length === 0) {
    el.innerHTML = `<span class="empty-pills">no folders yet</span>`;
    return;
  }

  el.innerHTML = pills
    .map((p) => {
      const active =
        (state.activeFolder === null && p.value === null) ||
        state.activeFolder === p.value;
      return `
        <button class="folder-pill ${active ? "active" : ""}" data-value="${p.value === null ? "__all__" : escapeHtml(p.value)}">
          <span>${escapeHtml(p.label)}</span>
          <span class="pill-count">${p.count}</span>
        </button>
      `;
    })
    .join("");

  $$(".folder-pill").forEach((btn) =>
    btn.addEventListener("click", () => {
      const v = btn.dataset.value;
      state.activeFolder = v === "__all__" ? null : v === "__none__" ? "" : v;
      renderList();
    }),
  );
}

// ---- popover (3-dot menu) -----------------------------------------------

function showPopover(anchorBtn) {
  const id = anchorBtn.dataset.id;
  state.popoverTargetId = id;
  const pop = $("#popover");
  pop.classList.remove("hidden");

  const rect = anchorBtn.getBoundingClientRect();
  // Position to the right of the dots, but clip into viewport
  const top = rect.top;
  const left = rect.right + 4;
  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;

  // After the popover renders, nudge if it would overflow
  requestAnimationFrame(() => {
    const popRect = pop.getBoundingClientRect();
    if (popRect.right > window.innerWidth - 8) {
      pop.style.left = `${rect.left - popRect.width - 4}px`;
    }
    if (popRect.bottom > window.innerHeight - 8) {
      pop.style.top = `${window.innerHeight - popRect.height - 8}px`;
    }
  });

  // Highlight the parent meeting-item
  $$(".meeting-item.menu-open").forEach((el) => el.classList.remove("menu-open"));
  anchorBtn.closest(".meeting-item")?.classList.add("menu-open");
}

function hidePopover() {
  $("#popover").classList.add("hidden");
  $$(".meeting-item.menu-open").forEach((el) => el.classList.remove("menu-open"));
  state.popoverTargetId = null;
}

async function onPopoverAction(action, e) {
  e.stopPropagation();
  const id = state.popoverTargetId;
  hidePopover();
  if (!id) return;
  if (action === "rename") return renameMeeting(id);
  if (action === "delete") return deleteMeeting(id);
  if (action === "move") return openMoveDialog(id);
}

/**
 * Inline rename: swap the sidebar title <div> for an <input>, focus +
 * select all, save on Enter / blur, cancel on Escape. No modal — feels
 * native, like Finder's rename.
 */
async function renameMeeting(id) {
  const item = document.querySelector(`.meeting-item[data-id="${CSS.escape(id)}"]`);
  if (!item) return;
  const titleEl = item.querySelector(".meeting-item-title");
  if (!titleEl || titleEl.dataset.editing === "1") return;

  const original = titleEl.textContent ?? "";
  titleEl.dataset.editing = "1";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "meeting-item-title-input";
  input.value = original;
  input.spellcheck = false;

  titleEl.replaceWith(input);
  // Need to wait a frame for the input to be in the DOM before
  // focus+select takes effect on some browsers.
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });

  let settled = false;
  const restore = (finalText) => {
    if (settled) return;
    settled = true;
    const span = document.createElement("div");
    span.className = "meeting-item-title";
    span.textContent = finalText;
    input.replaceWith(span);
  };

  const save = async () => {
    const next = input.value.trim();
    if (!next || next === original) {
      restore(original);
      return;
    }
    restore(next);
    await window.shruti.meetings.update(id, { title: next });
    // Refresh state model + re-render — keeps grouping/order correct
    state.meetings = state.meetings.map((m) =>
      m.id === id ? { ...m, title: next } : m,
    );
    renderList();
    if (state.selectedId === id) {
      const updated = await window.shruti.meetings.get(id);
      if (updated) renderMeeting(updated);
    }
  };

  const cancel = () => restore(original);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
    e.stopPropagation();
  });
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("blur", save);
}

async function deleteMeeting(id) {
  const m = await window.shruti.meetings.get(id);
  if (!m) return;
  const ok = await ui.confirm(
    `"${m.title}" will be permanently removed, including its transcript and notes.`,
    {
      title: "Delete meeting?",
      confirmLabel: "Delete",
      danger: true,
    },
  );
  if (!ok) return;
  await window.shruti.meetings.delete(id);
  if (state.selectedId === id) state.selectedId = null;
  await refreshList();
}

// ---- folders -------------------------------------------------------------

function distinctFolders() {
  const set = new Set();
  for (const m of state.meetings) {
    if (m.folder) set.add(m.folder);
  }
  return Array.from(set).sort();
}

async function newFolder() {
  const name = await ui.prompt("", "", {
    title: "New folder",
    placeholder: "e.g. Acme Q3 planning",
    confirmLabel: "Create",
  });
  if (!name) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  await ui.alert(
    `Folder "${trimmed}" will appear once you move a meeting into it. Open a meeting → ⋯ → Move to folder.`,
    { title: "Folder created" },
  );
}

const NONE_FOLDER = "__none__";
const NONE_LABEL = "(no folder)";

async function openMoveDialog(id) {
  state.moveTargetId = id;
  const m = await window.shruti.meetings.get(id);
  const currentRaw = m?.folder ?? null;
  const folders = distinctFolders();

  // Always show "(no folder)" first; then existing folders, with the
  // current one marked.
  const options = [
    { value: NONE_FOLDER, label: NONE_LABEL, current: currentRaw === null },
    ...folders.map((f) => ({ value: f, label: f, current: f === currentRaw })),
  ];

  $("#move-folders").innerHTML = options
    .map(
      (o) =>
        `<button type="button" class="move-folder-option ${o.current ? "current" : ""}" data-folder="${escapeHtml(o.value)}">${escapeHtml(o.label)}</button>`,
    )
    .join("");

  $$(".move-folder-option").forEach((btn) =>
    btn.addEventListener("click", () => {
      $$(".move-folder-option").forEach((b) => b.classList.remove("current"));
      btn.classList.add("current");
      $("#new-folder-name").value = "";
    }),
  );
  $("#new-folder-name").value = "";
  $("#move-dialog").showModal();
}

async function confirmMove() {
  const id = state.moveTargetId;
  if (!id) return;
  const newName = $("#new-folder-name").value.trim();
  let folder;
  if (newName) {
    folder = newName;
  } else {
    const sel = document.querySelector(".move-folder-option.current");
    folder = sel
      ? sel.dataset.folder === NONE_FOLDER
        ? null
        : sel.dataset.folder
      : null;
  }
  await window.shruti.meetings.update(id, { folder });
  $("#move-dialog").close();
  state.moveTargetId = null;
  await refreshList(state.selectedId);
}

async function selectMeeting(id) {
  state.selectedId = id;
  const m = await window.shruti.meetings.get(id);
  if (!m) {
    showEmpty();
    return;
  }
  renderMeeting(m);
  renderList(); // restyle selection
}

function showEmpty() {
  $("#empty-state").classList.remove("hidden");
  $("#meeting-view").classList.add("hidden");
}

function renderMeeting(m) {
  $("#empty-state").classList.add("hidden");
  $("#meeting-view").classList.remove("hidden");

  $("#meeting-title").value = m.title || "";
  const date = new Date(m.created_at);
  $("#meeting-date").textContent = date.toLocaleString();
  $("#meeting-duration").textContent = `${Math.round(m.duration_s / 60)} min`;
  $("#notes-area").value = m.notes ?? "";

  // Summary
  const sum = $("#summary-content");
  if (m.summary?.full_markdown) {
    sum.innerHTML = mdToHtml(m.summary.full_markdown);
  } else {
    sum.innerHTML = `<div class="empty">no summary yet — click <strong>Re-summarize</strong> after setting your OpenRouter key in Settings.</div>`;
  }

  // Transcript
  const tr = $("#transcript-content");
  if (m.transcript.utterances.length === 0) {
    tr.innerHTML = `<div class="empty">no transcript content captured.</div>`;
  } else {
    tr.innerHTML = m.transcript.utterances
      .map((u) => {
        const ts = formatTs(u.ts[0]);
        const speakerCls = u.speaker.toLowerCase().startsWith("me") ? "" : "other";
        return `
          <div class="utterance">
            <div class="ts">${ts}</div>
            <div class="speaker ${speakerCls}">${escapeHtml(u.speaker)}</div>
            <div class="text">${escapeHtml(u.text)}</div>
          </div>
        `;
      })
      .join("");
  }

}

async function resummarize() {
  if (!state.selectedId) return;
  const btn = $("#resummarize-btn");
  btn?.classList.add("busy");
  $("#summary-content").innerHTML = `<div class="empty">summarizing…</div>`;
  try {
    const m = await window.shruti.meetings.resummarize(state.selectedId);
    renderMeeting(m);
  } catch (err) {
    $("#summary-content").innerHTML = `<div class="empty">error: ${escapeHtml(err.message)}</div>`;
  } finally {
    btn?.classList.remove("busy");
  }
}

// ---- tabs ----------------------------------------------------------------

function switchTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $$(".tab-pane").forEach((p) => p.classList.toggle("active", p.dataset.pane === name));
}

// ---- settings ------------------------------------------------------------

const PRESET_MODELS = [
  "anthropic/claude-haiku-4.5",
  "openai/gpt-5.5",
  "z-ai/glm-5.1",
  "minimax/minimax-m2.7",
  "google/gemini-2.5-flash",
];

async function openSettings() {
  const s = await window.shruti.settings.get();
  $("#smallest-key").value = s.smallestApiKey ?? "";
  $("#openrouter-key").value = s.openrouterApiKey ?? "";

  const theme = THEMES.includes(s.theme) ? s.theme : "light";
  setDropdownValue($("#theme-dropdown"), theme);

  const customInput = $("#openrouter-model");
  const current = s.openrouterModel ?? "anthropic/claude-haiku-4.5";

  if (PRESET_MODELS.includes(current)) {
    setDropdownValue($("#model-dropdown"), current);
    customInput.value = "";
    customInput.classList.add("hidden");
  } else {
    setDropdownValue($("#model-dropdown"), "__custom__");
    customInput.value = current;
    customInput.classList.remove("hidden");
  }
  $("#settings-dialog").showModal();
}

document.addEventListener("DOMContentLoaded", () => {
  const select = $("#openrouter-model-select");
  const customInput = $("#openrouter-model");
  if (select && customInput) {
    select.addEventListener("change", () => {
      if (select.value === "__custom__") {
        customInput.classList.remove("hidden");
        customInput.focus();
      } else {
        customInput.classList.add("hidden");
      }
    });
  }
});

async function saveSettings() {
  const customInput = $("#openrouter-model");
  const selectedModel = getDropdownValue($("#model-dropdown"));
  const model =
    selectedModel === "__custom__"
      ? customInput.value.trim() || "anthropic/claude-haiku-4.5"
      : selectedModel;

  try {
    const theme = getDropdownValue($("#theme-dropdown"));
    // Only update keys when the input has a value; an empty input
    // means "no change", not "wipe the existing key". To explicitly
    // clear, the user can re-set the key to a single space which we
    // would treat as empty. (Reasonable trade-off; the alternative is
    // a separate "Remove key" affordance which isn't worth the chrome
    // for an MVP.)
    const patch = {
      openrouterModel: model,
      theme,
    };
    const smallest = $("#smallest-key").value.trim();
    if (smallest) patch.smallestApiKey = smallest;
    const openrouter = $("#openrouter-key").value.trim();
    if (openrouter) patch.openrouterApiKey = openrouter;

    await window.shruti.settings.set(patch);
    applyTheme(theme);
    $("#settings-dialog").close();
  } catch (err) {
    await ui.alert(err.message, { title: "Couldn't save settings" });
  }
}

// ---- utils ---------------------------------------------------------------

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatTs(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/** super-light markdown → html (only what the summarizer emits). */
function mdToHtml(md) {
  let html = escapeHtml(md);
  html = html.replace(/^### (.*)$/gm, "<h3>$1</h3>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/_([^_]+)_/g, "<em>$1</em>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // turn lines starting with "- " into <ul><li>...
  const lines = html.split("\n");
  const out = [];
  let inList = false;
  for (const line of lines) {
    if (line.startsWith("- ")) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${line.slice(2)}</li>`);
    } else {
      if (inList) { out.push("</ul>"); inList = false; }
      if (line.trim()) out.push(`<p>${line}</p>`);
    }
  }
  if (inList) out.push("</ul>");
  return out.join("");
}
