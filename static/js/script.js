(() => {
  "use strict";

  const maxUploadBytes = Number(document.body.dataset.maxUploadBytes);
  const fileInput = document.getElementById("file-input");
  const dropzone = document.getElementById("dropzone");
  const browseButton = document.getElementById("browse-button");
  const queueList = document.getElementById("queue-list");
  const uploadButton = document.getElementById("upload-button");
  const uploadButtonLabel = document.getElementById("upload-button-label");
  const uploadProgress = document.getElementById("upload-progress");
  const progressLabel = document.getElementById("progress-label");
  const progressPercent = document.getElementById("progress-percent");
  const progressBar = document.getElementById("progress-bar");
  const fileList = document.getElementById("file-list");
  const emptyState = document.getElementById("empty-state");
  const noMatches = document.getElementById("no-matches");
  const resultsFooter = document.getElementById("results-footer");
  const deleteButton = document.getElementById("delete-button");
  const selectAll = document.getElementById("select-all");
  const searchInput = document.getElementById("search-input");
  const filterSelect = document.getElementById("filter-select");
  const toastRegion = document.getElementById("toast-region");
  const reportButton = document.getElementById("report-button");
  const duplicateGroupsPanel = document.getElementById("duplicate-groups-panel");
  const groupList = document.getElementById("group-list");
  const groupCount = document.getElementById("group-count");
  let queuedFiles = [];
  let currentResults = { files: [], groups: [], stats: {} };
  let isUploading = false;
  let isDeleting = false;

  function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    if (!Number.isFinite(bytes) || bytes < 0) return "—";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const amount = bytes / (1024 ** unitIndex);
    return `${amount.toLocaleString(undefined, { maximumFractionDigits: unitIndex === 0 ? 0 : 1 })} ${units[unitIndex]}`;
  }

  function showToast(message, kind = "success") {
    const toast = document.createElement("div");
    toast.className = `toast ${kind}`;
    toast.textContent = message;
    toastRegion.append(toast);
    window.setTimeout(() => toast.remove(), 4500);
  }

  async function readError(response) {
    try {
      const body = await response.json();
      return body.error || `Request failed (${response.status}).`;
    } catch (_error) {
      return `Request failed (${response.status}). Please try again.`;
    }
  }

  function updateStats(stats) {
    document.getElementById("total-files").textContent = stats.total_files.toLocaleString();
    document.getElementById("unique-files").textContent = stats.unique_files.toLocaleString();
    document.getElementById("duplicate-files").textContent = stats.duplicate_files.toLocaleString();
    document.getElementById("storage-savings").textContent = formatBytes(stats.storage_savings);
    reportButton.disabled = stats.total_files === 0;
    document.getElementById("results-subtitle").textContent = stats.total_files
      ? `${stats.total_files} file${stats.total_files === 1 ? "" : "s"} compared by content.`
      : "Your uploaded files will appear here.";
  }

  function createFileIcon() {
    const icon = document.createElement("span");
    icon.className = "queue-file-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "▤";
    return icon;
  }

  function renderQueue() {
    queueList.replaceChildren();
    queuedFiles.forEach((file, index) => {
      const item = document.createElement("li");
      item.className = "queue-item";
      const info = document.createElement("div");
      info.className = "queue-info";
      const name = document.createElement("div");
      name.className = "queue-name";
      name.textContent = file.name;
      name.title = file.name;
      const meta = document.createElement("div");
      meta.className = "queue-meta";
      meta.textContent = `${formatBytes(file.size)} · ${file.type || "Unknown file type"}`;
      info.append(name, meta);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove-queued";
      remove.setAttribute("aria-label", `Remove ${file.name} from the upload queue`);
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        queuedFiles.splice(index, 1);
        renderQueue();
      });
      item.append(createFileIcon(), info, remove);
      queueList.append(item);
    });
    uploadButton.disabled = queuedFiles.length === 0 || isUploading;
    uploadButtonLabel.textContent = queuedFiles.length
      ? `Scan ${queuedFiles.length} file${queuedFiles.length === 1 ? "" : "s"}`
      : "Select files to scan";
  }

  function addFiles(fileCollection) {
    const files = Array.from(fileCollection);
    if (!files.length) return;

    const tooLarge = files.find((file) => file.size > maxUploadBytes);
    if (tooLarge) {
      showToast(`${tooLarge.name} exceeds the ${formatBytes(maxUploadBytes)} upload limit.`, "error");
      return;
    }
    const queuedBytes = queuedFiles.reduce((total, file) => total + file.size, 0);
    const addedBytes = files.reduce((total, file) => total + file.size, 0);
    if (queuedBytes + addedBytes > maxUploadBytes) {
      showToast(`The selected files exceed the ${formatBytes(maxUploadBytes)} upload limit.`, "error");
      return;
    }

    queuedFiles.push(...files);
    renderQueue();
  }

  function matchesFilter(file) {
    const filter = filterSelect.value;
    if (filter === "duplicates") return file.is_duplicate_copy;
    if (filter === "unique") return !file.is_duplicate_copy;
    return true;
  }

  function renderResults() {
    const query = searchInput.value.trim().toLocaleLowerCase();
    const visibleFiles = currentResults.files.filter((file) => {
      const matchesSearch = file.name.toLocaleLowerCase().includes(query)
        || file.sha256.toLocaleLowerCase().includes(query);
      return matchesSearch && matchesFilter(file);
    });

    fileList.replaceChildren();
    emptyState.hidden = currentResults.files.length > 0;
    fileList.hidden = currentResults.files.length === 0 || visibleFiles.length === 0;
    noMatches.hidden = currentResults.files.length === 0 || visibleFiles.length > 0;
    resultsFooter.hidden = currentResults.files.length === 0;
    document.getElementById("scan-status").innerHTML = currentResults.files.length
      ? "<span></span> SCANNED"
      : "<span></span> READY";

    visibleFiles.forEach((file) => {
      const row = document.createElement("div");
      row.className = `file-row${file.is_duplicate_copy ? " is-duplicate" : ""}`;
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "file-checkbox";
      checkbox.value = file.id;
      checkbox.setAttribute("aria-label", `Select duplicate copy ${file.name}`);
      checkbox.disabled = !file.is_duplicate_copy || isDeleting;
      checkbox.addEventListener("change", updateDeleteButton);

      const info = document.createElement("div");
      info.className = "file-main";
      const name = document.createElement("div");
      name.className = "file-name";
      name.textContent = file.name;
      name.title = file.name;
      const meta = document.createElement("div");
      meta.className = "file-meta";
      meta.textContent = `${formatBytes(file.size)} · SHA-256 ${file.sha256.slice(0, 12)}…`;
      info.append(name, meta);
      const badge = document.createElement("span");
      badge.className = "file-badge";
      badge.textContent = file.is_duplicate_copy ? "DUPLICATE" : "UNIQUE";
      row.append(checkbox, createFileIcon(), info, badge);
      if (!file.is_duplicate_copy) row.classList.add("is-keeper");
      fileList.append(row);
    });

    const duplicateGroups = currentResults.groups.filter((group) => {
      const searchMatches = !query || group.sha256.toLocaleLowerCase().includes(query)
        || group.files.some((file) => file.name.toLocaleLowerCase().includes(query));
      return searchMatches && filterSelect.value !== "unique";
    });
    duplicateGroupsPanel.hidden = currentResults.groups.length === 0;
    groupCount.textContent = `${currentResults.groups.length} group${currentResults.groups.length === 1 ? "" : "s"}`;
    groupList.replaceChildren();
    duplicateGroups.forEach((group) => {
      const card = document.createElement("article");
      card.className = "group-card";
      const top = document.createElement("div");
      top.className = "group-card-top";
      const heading = document.createElement("h4");
      heading.textContent = group.files[0].name;
      heading.title = group.files[0].name;
      const count = document.createElement("span");
      count.className = "group-copy-count";
      count.textContent = `${group.count} copies`;
      top.append(heading, count);
      const hash = document.createElement("div");
      hash.className = "hash-label";
      hash.textContent = `${group.sha256.slice(0, 16)}…`;
      hash.title = group.sha256;
      card.append(top, hash);

      group.files.forEach((file) => {
        const member = document.createElement("div");
        member.className = "group-member";
        const mark = document.createElement("span");
        mark.textContent = file.is_duplicate_copy ? "↳" : "✓";
        const memberName = document.createElement("strong");
        memberName.textContent = file.name;
        memberName.title = file.name;
        member.append(mark, memberName);
        if (!file.is_duplicate_copy) {
          const keeper = document.createElement("span");
          keeper.className = "group-savings";
          keeper.textContent = "KEEP";
          member.append(keeper);
        }
        card.append(member);
      });
      const savings = document.createElement("div");
      savings.className = "group-member";
      savings.innerHTML = `<span aria-hidden="true">✧</span><strong>Potential savings</strong><span class="group-savings">${formatBytes(group.savings)}</span>`;
      card.append(savings);
      groupList.append(card);
    });
    updateDeleteButton();
  }

  function updateDeleteButton() {
    const checkedCount = fileList.querySelectorAll(".file-checkbox:checked").length;
    deleteButton.disabled = checkedCount === 0 || isDeleting;
    selectAll.checked = checkedCount > 0
      && checkedCount === fileList.querySelectorAll(".file-checkbox:not(:disabled)").length;
    selectAll.indeterminate = checkedCount > 0 && !selectAll.checked;
    selectAll.disabled = isDeleting || fileList.querySelectorAll(".file-checkbox:not(:disabled)").length === 0;
  }

  function applyResults(results) {
    currentResults = results;
    updateStats(results.stats);
    renderResults();
  }

  async function loadResults() {
    document.getElementById("scan-status").innerHTML = "<span></span> LOADING";
    try {
      const response = await fetch("/api/results");
      if (!response.ok) throw new Error(await readError(response));
      applyResults(await response.json());
    } catch (error) {
      document.getElementById("scan-status").textContent = "ERROR";
      showToast(error.message || "Could not load scan results.", "error");
    }
  }

  function uploadQueuedFiles() {
    if (!queuedFiles.length || isUploading) return;
    const formData = new FormData();
    queuedFiles.forEach((file) => formData.append("files", file, file.name));
    isUploading = true;
    uploadButton.classList.add("is-loading");
    uploadButton.disabled = true;
    uploadButtonLabel.textContent = "Uploading and scanning…";
    uploadProgress.hidden = false;
    progressLabel.textContent = "Uploading and calculating SHA-256…";
    progressPercent.textContent = "0%";
    progressBar.style.width = "0%";

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      const percent = Math.round((event.loaded / event.total) * 100);
      progressPercent.textContent = `${percent}%`;
      progressBar.style.width = `${percent}%`;
    });
    xhr.addEventListener("load", () => {
      let response;
      try {
        response = JSON.parse(xhr.responseText);
      } catch (_error) {
        finishUpload();
        showToast("The server returned an unreadable response. Please refresh and try again.", "error");
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        finishUpload();
        showToast(response.error || `Upload failed (${xhr.status}).`, "error");
        return;
      }
      applyResults(response);
      queuedFiles = [];
      renderQueue();
      progressLabel.textContent = "Upload complete";
      progressPercent.textContent = "100%";
      progressBar.style.width = "100%";
      showToast(response.message, "success");
      finishUpload(true);
    });
    xhr.addEventListener("error", () => {
      finishUpload();
      showToast("Could not reach the server. Check your connection and try again.", "error");
    });
    xhr.send(formData);
  }

  function finishUpload(completed = false) {
    isUploading = false;
    uploadButton.classList.remove("is-loading");
    uploadButton.disabled = queuedFiles.length === 0;
    uploadButtonLabel.textContent = queuedFiles.length
      ? `Scan ${queuedFiles.length} file${queuedFiles.length === 1 ? "" : "s"}`
      : "Select files to scan";
    if (!completed) {
      window.setTimeout(() => { uploadProgress.hidden = true; }, 1400);
    } else {
      window.setTimeout(() => { uploadProgress.hidden = true; }, 1800);
    }
  }

  async function removeSelected() {
    const selectedIds = Array.from(fileList.querySelectorAll(".file-checkbox:checked"))
      .map((checkbox) => checkbox.value);
    if (!selectedIds.length || isDeleting) return;
    const confirmed = window.confirm(
      `Remove ${selectedIds.length} selected duplicate copy/copies from this server? This will not delete files from your device.`
    );
    if (!confirmed) return;

    isDeleting = true;
    deleteButton.textContent = "Removing…";
    deleteButton.disabled = true;
    try {
      const response = await fetch("/api/files", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_ids: selectedIds }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const results = await response.json();
      applyResults(results);
      showToast(results.message, "success");
    } catch (error) {
      showToast(error.message || "Could not remove the selected duplicate copies.", "error");
    } finally {
      isDeleting = false;
      deleteButton.innerHTML = '<span aria-hidden="true">⌫</span> Remove selected';
      renderResults();
    }
  }

  browseButton.addEventListener("click", (event) => {
    event.stopPropagation();
    fileInput.click();
  });
  dropzone.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    fileInput.click();
  });
  dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener("change", () => {
    addFiles(fileInput.files);
    fileInput.value = "";
  });
  ["dragenter", "dragover"].forEach((eventName) => {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.add("is-dragging");
    });
  });
  ["dragleave", "drop"].forEach((eventName) => {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.remove("is-dragging");
    });
  });
  dropzone.addEventListener("drop", (event) => addFiles(event.dataTransfer.files));
  uploadButton.addEventListener("click", uploadQueuedFiles);
  searchInput.addEventListener("input", renderResults);
  filterSelect.addEventListener("change", renderResults);
  selectAll.addEventListener("change", () => {
    fileList.querySelectorAll(".file-checkbox:not(:disabled)").forEach((checkbox) => {
      checkbox.checked = selectAll.checked;
    });
    updateDeleteButton();
  });
  deleteButton.addEventListener("click", removeSelected);
  reportButton.addEventListener("click", () => {
    window.location.assign("/api/report.csv");
  });

  loadResults();
})();
