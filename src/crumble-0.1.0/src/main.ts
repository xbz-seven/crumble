import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

let packSources: string[] = [];
let crumbsPath: string | null = null;
let allEntries: FileEntryInfo[] = [];
let selectedEntries: Set<string> = new Set();
let installDir: string | null = null;
let resolveConfirm: ((ok: boolean) => void) | null = null;

interface FileEntryInfo {
  path: string;
  id: string;
  is_duplicate: boolean;
}

interface LibraryEntry {
  pkg_id: string;
  name: string;
  path: string;
  packed_at: string;
  file_count: number;
  total_size: number;
  files: { path: string; id: string; size: number }[];
}

const tabPack = document.getElementById("tab-pack")!;
const tabUnpack = document.getElementById("tab-unpack")!;
const tabLibrary = document.getElementById("tab-library")!;
const panelPack = document.getElementById("panel-pack")!;
const panelUnpack = document.getElementById("panel-unpack")!;
const panelLibrary = document.getElementById("panel-library")!;

const dropPack = document.getElementById("drop-zone-pack")!;
const sourceList = document.getElementById("source-list")!;
const packPwd = document.getElementById("pack-password") as HTMLInputElement;
const btnPack = document.getElementById("btn-pack") as HTMLButtonElement;
const packStatus = document.getElementById("pack-status")!;
const btnSelectFiles = document.getElementById("btn-select-files")!;
const btnSelectFolder = document.getElementById("btn-select-folder")!;

const dropUnpack = document.getElementById("drop-zone-unpack")!;
const selectedCrumbs = document.getElementById("selected-crumbs")!;
const unpackPwd = document.getElementById("unpack-password") as HTMLInputElement;
const btnSelectCrumbs = document.getElementById("btn-select-crumbs")!;
const btnScan = document.getElementById("btn-scan") as HTMLButtonElement;
const contentsArea = document.getElementById("contents-area")!;
const fileTree = document.getElementById("file-tree")!;
const masterCheck = document.getElementById("master-check") as HTMLInputElement;
const btnToggleAll = document.getElementById("btn-toggle-all")!;
const installDirInput = document.getElementById("install-dir") as HTMLInputElement;
const btnSelectDir = document.getElementById("btn-select-dir")!;
const btnInstall = document.getElementById("btn-install") as HTMLButtonElement;
const unpackStatus = document.getElementById("unpack-status")!;

const libList = document.getElementById("lib-list")!;
const btnClearLib = document.getElementById("btn-clear-lib")!;

const confirmOverlay = document.getElementById("confirm-overlay")!;
const confirmMsg = document.getElementById("confirm-msg")!;
const confirmOk = document.getElementById("confirm-ok")!;
const confirmCancel = document.getElementById("confirm-cancel")!;

function showTab(tab: "pack" | "unpack" | "library") {
  tabPack.classList.toggle("active", tab === "pack");
  tabUnpack.classList.toggle("active", tab === "unpack");
  tabLibrary.classList.toggle("active", tab === "library");
  panelPack.classList.toggle("active", tab === "pack");
  panelUnpack.classList.toggle("active", tab === "unpack");
  panelLibrary.classList.toggle("active", tab === "library");
  if (tab === "library") refreshLibrary();
}

tabPack.addEventListener("click", () => showTab("pack"));
tabUnpack.addEventListener("click", () => showTab("unpack"));
tabLibrary.addEventListener("click", () => showTab("library"));

function preventDefaults(e: Event) { e.preventDefault(); e.stopPropagation(); }

function onDragOver(this: HTMLElement, e: DragEvent) {
  preventDefaults(e);
  this.classList.add("drag-over");
}

function onDragLeave(this: HTMLElement, e: DragEvent) {
  preventDefaults(e);
  this.classList.remove("drag-over");
}

dropPack.addEventListener("dragover", onDragOver);
dropPack.addEventListener("dragleave", onDragLeave);
dropPack.addEventListener("drop", (e: DragEvent) => {
  preventDefaults(e);
  dropPack.classList.remove("drag-over");
  const files = Array.from(e.dataTransfer?.files ?? []);
  packSources = files.map((f) => f.name);
  updatePackUI();
});

dropUnpack.addEventListener("dragover", onDragOver);
dropUnpack.addEventListener("dragleave", onDragLeave);
dropUnpack.addEventListener("drop", (e: DragEvent) => {
  preventDefaults(e);
  dropUnpack.classList.remove("drag-over");
  const file = e.dataTransfer?.files?.[0];
  if (file && file.name.endsWith(".crumbs")) {
    crumbsPath = file.name;
    selectedCrumbs.textContent = file.name;
    resetUnpack();
    updateUnpackUI();
  }
});

btnSelectFiles.addEventListener("click", async () => {
  const selected = await open({ multiple: true, title: "Select files to pack" });
  if (selected) {
    packSources = Array.isArray(selected) ? selected : [selected];
    updatePackUI();
  }
});

btnSelectFolder.addEventListener("click", async () => {
  const selected = await open({ multiple: false, directory: true, title: "Select a folder to pack" });
  if (selected) {
    packSources = [typeof selected === "string" ? selected : selected[0]];
    updatePackUI();
  }
});

btnSelectCrumbs.addEventListener("click", async () => {
  const selected = await open({
    multiple: false,
    title: "Select a .crumbs file",
    filters: [{ name: "Crumble Pack", extensions: ["crumbs"] }],
  });
  if (selected) {
    crumbsPath = typeof selected === "string" ? selected : selected[0];
    selectedCrumbs.textContent = crumbsPath;
    resetUnpack();
    updateUnpackUI();
  }
});

btnSelectDir.addEventListener("click", async () => {
  const dir = await open({ multiple: false, directory: true, title: "Select install destination" });
  if (dir) {
    installDir = typeof dir === "string" ? dir : dir[0];
    installDirInput.value = installDir;
    updateUnpackUI();
  }
});

btnScan.addEventListener("click", async () => {
  const password = unpackPwd.value || "default";
  unpackStatus.textContent = "Scanning package…";

  try {
    const entries: FileEntryInfo[] = await invoke("list_crumbs", {
      source: crumbsPath,
      password,
    }) as FileEntryInfo[];
    allEntries = entries;
    selectedEntries = new Set();
    renderFileTree(entries);
    contentsArea.classList.remove("hidden");
    unpackStatus.textContent = `${entries.length} file(s) found. Toggle the ones you want, then choose a destination and install.`;
    updateUnpackUI();
  } catch (err) {
    unpackStatus.textContent = `Error: ${err}`;
  }
});

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  id: string;
  isDup: boolean;
  children: TreeNode[];
}

function buildTree(entries: FileEntryInfo[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const e of entries) {
    const parts = e.path.split("/");
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      let existing = current.find((n) => n.name === part);
      if (!existing) {
        existing = {
          name: part,
          path: parts.slice(0, i + 1).join("/"),
          isDir: !isLast,
          id: isLast ? e.id : "",
          isDup: isLast ? e.is_duplicate : false,
          children: [],
        };
        current.push(existing);
      }
      if (!isLast) current = existing.children;
    }
  }
  return root;
}

function renderFileTree(entries: FileEntryInfo[]) {
  const tree = buildTree(entries);
  fileTree.innerHTML = "";
  for (const node of tree) fileTree.appendChild(renderNode(node, 0));
}

function renderNode(node: TreeNode, depth: number): HTMLElement {
  const container = document.createElement("div");
  const item = document.createElement("div");
  item.className = "file-item" + (node.isDir ? " dir" : "");

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = selectedEntries.has(node.path);
  cb.addEventListener("change", () => {
    toggleNode(node, cb.checked);
    updateUnpackUI();
  });

  const label = document.createElement("span");
  label.className = "label";
  let suffix = "";
  if (node.isDup) suffix = " [duplicate]";
  label.textContent = node.name + suffix;
  if (node.isDup) label.style.color = "#c00";
  label.style.paddingLeft = `${depth * 14}px`;

  item.appendChild(cb);
  item.appendChild(label);
  container.appendChild(item);

  if (node.children.length > 0) {
    const childrenDiv = document.createElement("div");
    childrenDiv.className = "file-children";
    for (const child of node.children) childrenDiv.appendChild(renderNode(child, depth + 1));
    container.appendChild(childrenDiv);
  }

  return container;
}

function toggleNode(node: TreeNode, checked: boolean) {
  if (checked) selectedEntries.add(node.path);
  else selectedEntries.delete(node.path);
  if (node.isDir) for (const child of node.children) toggleNode(child, checked);
}

function syncMasterCheck() {
  if (allEntries.length === 0) return;
  const allSelected = allEntries.every((e) => selectedEntries.has(e.path));
  const noneSelected = selectedEntries.size === 0;
  masterCheck.checked = allSelected;
  masterCheck.indeterminate = !allSelected && !noneSelected;
}

masterCheck.addEventListener("change", () => {
  if (masterCheck.checked) for (const e of allEntries) selectedEntries.add(e.path);
  else selectedEntries.clear();
  renderFileTree(allEntries);
  updateUnpackUI();
});

btnToggleAll.addEventListener("click", () => {
  const allSelected = allEntries.every((e) => selectedEntries.has(e.path));
  if (allSelected) selectedEntries.clear();
  else for (const e of allEntries) selectedEntries.add(e.path);
  renderFileTree(allEntries);
  updateUnpackUI();
});

function showConfirm(msg: string): Promise<boolean> {
  return new Promise((resolve) => {
    confirmMsg.textContent = msg;
    confirmOverlay.classList.remove("hidden");
    resolveConfirm = resolve;
  });
}

confirmOk.addEventListener("click", () => {
  confirmOverlay.classList.add("hidden");
  resolveConfirm?.(true);
});

confirmCancel.addEventListener("click", () => {
  confirmOverlay.classList.add("hidden");
  resolveConfirm?.(false);
});

btnInstall.addEventListener("click", async () => {
  if (!crumbsPath || !installDir) return;
  const selected = allEntries.filter((e) => selectedEntries.has(e.path));
  if (selected.length === 0) { unpackStatus.textContent = "No files selected."; return; }

  const fileName = crumbsPath.split("/").pop() || crumbsPath.split("\\").pop() || crumbsPath;
  const ok = await showConfirm(
    `Are you sure? This will install ${selected.length} file(s) from "${fileName}" to "${installDir}"`
  );
  if (!ok) { unpackStatus.textContent = "Cancelled."; return; }

  const password = unpackPwd.value || "default";
  unpackStatus.textContent = "Installing…";
  try {
    const msg: string = await invoke("unpack_selected", {
      source: crumbsPath,
      outputDir: installDir,
      password,
      selected: selected.map((e) => e.path),
    }) as string;
    unpackStatus.textContent = msg;
  } catch (err) {
    unpackStatus.textContent = `Error: ${err}`;
  }
});

btnPack.addEventListener("click", async () => {
  const password = packPwd.value || "default";
  packStatus.textContent = "Saving .crumbs file…";

  const baseName = packSources.length > 0
    ? (packSources[0].split("/").pop() || packSources[0].split("\\").pop() || "archive")
    : "archive";
  const defaultName = baseName.replace(/\.\w+$/, "") + ".crumbs";

  const dest = await save({
    title: "Save .crumbs file",
    filters: [{ name: "Crumble Pack", extensions: ["crumbs"] }],
    defaultPath: defaultName,
  });
  if (!dest) { packStatus.textContent = "Cancelled."; return; }

  try {
    const msg: string = await invoke("pack_files", {
      sources: packSources,
      output: dest,
      password,
    }) as string;
    packStatus.textContent = msg;
  } catch (err) {
    packStatus.textContent = `Error: ${err}`;
  }
});

async function refreshLibrary() {
  try {
    const lib: LibraryEntry[] = await invoke("get_library") as LibraryEntry[];
    libList.innerHTML = "";
    if (lib.length === 0) {
      libList.innerHTML = '<div class="lib-empty">No packages packed yet.</div>';
      return;
    }
    for (const entry of lib) {
      const div = document.createElement("div");
      div.className = "lib-entry";
      const date = entry.packed_at ? new Date(entry.packed_at).toLocaleString() : "unknown";
      const sizeStr = entry.total_size > 1024 * 1024
        ? (entry.total_size / 1024 / 1024).toFixed(1) + " MB"
        : (entry.total_size / 1024).toFixed(1) + " KB";

      const installBtn = document.createElement("button");
      installBtn.className = "lib-install";
      installBtn.textContent = "Install";
      installBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        crumbsPath = entry.path;
        selectedCrumbs.textContent = crumbsPath;
        resetUnpack();
        updateUnpackUI();
        showTab("unpack");
      });

      div.innerHTML = `
        <div class="lib-row">
          <div>
            <h3>${entry.name}</h3>
            <div class="lib-meta">${entry.file_count} file(s) &middot; ${sizeStr} &middot; ${date}</div>
          </div>
        </div>
        <div class="lib-files">${entry.files.map((f) => f.path).join("<br>")}</div>
      `;
      div.querySelector(".lib-row")!.appendChild(installBtn);
      libList.appendChild(div);
    }
  } catch {
    libList.innerHTML = '<div class="lib-empty">Could not load library.</div>';
  }
}

btnClearLib.addEventListener("click", async () => {
  const ok = await showConfirm("Clear the entire library?");
  if (!ok) return;
  await invoke("clear_library");
  refreshLibrary();
});

function updatePackUI() {
  sourceList.innerHTML = packSources.map((s) => `<li>${s}</li>`).join("");
  btnPack.disabled = packSources.length === 0;
  packStatus.textContent = "";
}

function updateUnpackUI() {
  const hasSelected = selectedEntries.size > 0;
  btnScan.disabled = !crumbsPath;
  btnInstall.disabled = !hasSelected || !installDir;
  syncMasterCheck();
}

function resetUnpack() {
  allEntries = [];
  selectedEntries = new Set();
  installDir = null;
  installDirInput.value = "";
  contentsArea.classList.add("hidden");
  fileTree.innerHTML = "";
  unpackStatus.textContent = "";
}

updatePackUI();
updateUnpackUI();
