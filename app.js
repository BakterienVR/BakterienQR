// ───── State ─────
let config = null;
let qrScanner = null;
let viewer3d = null;
let activeQuiz = null;

const VIEWER_MODULE_URL = "./viewer3d.js?v=1";

const screens = {
  welcome: document.getElementById("welcome"),
  scanner: document.getElementById("scanner"),
  loading: document.getElementById("loading"),
  error: document.getElementById("error"),
  fishView: document.getElementById("fishView"),
};

const rescanBtn = document.getElementById("rescanBtn");
const scanStatus = document.getElementById("scanStatus");
const scanPreview = document.getElementById("scanPreview");
const scanDetectedName = document.getElementById("scanDetectedName");
const confirmScanBtn = document.getElementById("confirmScanBtn");

let scannedText = null;

// ───── 3D-Viewer (lazy) ─────
async function loadViewer3d() {
  if (viewer3d) return viewer3d;
  if (window.importShim) {
    await importShim.ready;
    viewer3d = await importShim(VIEWER_MODULE_URL);
  } else {
    viewer3d = await import(VIEWER_MODULE_URL);
  }
  return viewer3d;
}

function disposeViewerScene() {
  viewer3d?.disposeScene();
}

function showModelUnavailable(msg) {
  const container = document.getElementById("modelContainer");
  Array.from(container.querySelectorAll("canvas")).forEach((c) => c.remove());
  let el = container.querySelector(".model-unavailable");
  if (!el) {
    el = document.createElement("p");
    el.className = "model-unavailable iwm-status";
    container.appendChild(el);
  }
  el.textContent = msg;
}

// ───── Screen Helper ─────
function showScreen(name) {
  for (const [k, el] of Object.entries(screens)) {
    el.classList.toggle("hidden", k !== name);
  }
  rescanBtn.classList.toggle("hidden", name === "welcome" || name === "scanner");
}

// ───── Config laden ─────
async function loadConfig() {
  try {
    const res = await fetch("config.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    config = await res.json();
  } catch (e) {
    showError(
      "config.json konnte nicht geladen werden. Stelle sicher, dass die App über einen Webserver läuft (nicht per Doppelklick)."
    );
    throw e;
  }
}

// ───── QR-Text → Inhalt ─────
function normalizeQrText(value) {
  if (!value) return "";
  return value.trim().toLocaleLowerCase("de-DE").replace(/\s+/g, " ");
}

function findContentByQrText(qrText) {
  const target = normalizeQrText(qrText);
  if (!target) return null;
  for (const [id, data] of Object.entries(config.Inhalte || {})) {
    if (normalizeQrText(data.qrText) === target) return { id, ...data };
  }
  return null;
}

// ───── Scanner ─────
function resetScanState() {
  scannedText = null;
  scanStatus.textContent = "Halte den QR-Code in den Rahmen…";
  scanPreview.classList.add("hidden");
  scanDetectedName.textContent = "";
  confirmScanBtn.disabled = true;
}

function stripMarkdown(md) {
  return String(md || "").replace(/\*+/g, "");
}

function updateScanPreview() {
  const content = findContentByQrText(scannedText);
  if (content) {
    scanStatus.textContent = "QR-Code erkannt – tippe auf „Inhalt anzeigen“";
    scanDetectedName.textContent = stripMarkdown(content.name);
    scanPreview.classList.remove("hidden");
    confirmScanBtn.disabled = false;
  } else {
    scanStatus.textContent = "QR-Code erkannt, aber kein passender Inhalt in der Datenbank.";
    scanPreview.classList.add("hidden");
    confirmScanBtn.disabled = true;
  }
}

async function startScan() {
  if (typeof Html5Qrcode === "undefined") {
    showError("QR-Scanner-Bibliothek konnte nicht geladen werden. Prüfe deine Internetverbindung.");
    return;
  }

  showScreen("scanner");
  resetScanState();

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
    stream.getTracks().forEach((t) => t.stop());
  } catch (permErr) {
    console.error("Kamerazugriff verweigert/fehlgeschlagen:", permErr);
    const name = permErr && permErr.name;
    let msg;
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      msg =
        "Du hast den Kamerazugriff abgelehnt. Setze die Berechtigung in den Browser-Einstellungen zurück (Schloss-Symbol in der Adressleiste → Website-Einstellungen → Kamera erlauben) und versuche es erneut.";
    } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      msg = "Es wurde keine Kamera gefunden.";
    } else if (name === "NotReadableError") {
      msg = "Die Kamera wird gerade von einer anderen App verwendet.";
    } else {
      msg = `Kamera konnte nicht geöffnet werden (${name || "unbekannter Fehler"}).`;
    }
    showError(msg);
    return;
  }

  try {
    qrScanner = new Html5Qrcode("qr-reader", { verbose: false });
    await qrScanner.start(
      { facingMode: "environment" },
      {
        fps: 10,
        qrbox: (vw, vh) => {
          const min = Math.min(vw, vh);
          const size = Math.floor(min * 0.7);
          return { width: size, height: size };
        },
      },
      onScanSuccess,
      () => {}
    );
  } catch (e) {
    console.error(e);
    showError(
      "Kamera konnte nicht gestartet werden: " + (e?.message || e) +
      "\n\nErlaube den Kamerazugriff in den Browsereinstellungen und versuche es erneut."
    );
  }
}

async function stopScan() {
  if (!qrScanner) return;
  try { await qrScanner.stop(); } catch (e) { /* ignore */ }
  try { qrScanner.clear(); } catch (e) { /* ignore */ }
  qrScanner = null;
}

function onScanSuccess(decodedText) {
  if (decodedText === scannedText) return;
  scannedText = decodedText;
  updateScanPreview();
}

async function confirmScan() {
  if (!scannedText || confirmScanBtn.disabled) return;
  await stopScan();
  await handleQrText(scannedText);
}

// ───── QR-Text verarbeiten ─────
async function handleQrText(qrText) {
  const content = findContentByQrText(qrText);
  if (!content) {
    showError(`Für den gescannten Text wurde kein passender Inhalt in der config.json gefunden:\n\n${qrText}`);
    return;
  }
  await displayContent(content);
}

// ───── Inhalt anzeigen ─────
async function displayContent(content) {
  showScreen("loading");
  document.getElementById("loadingMsg").textContent = `Lade ${stripMarkdown(content.name)}…`;

  try {
    const textRaw = await fetch(`Assets/Texts/${content.text}`).then((r) => {
      if (!r.ok) throw new Error(`Text "${content.text}" nicht gefunden (${r.status})`);
      return r.text();
    });

    document.getElementById("fishTitle").innerHTML = parseInlineMarkdown(content.name);

    renderInfoText(textRaw, content.images);
    activeQuiz = content.quiz;
    renderQuiz(activeQuiz);

    const sourceBox = document.querySelector(".iwm-source");
    const sourceText = document.getElementById("sourceText");
    const sourceLink = document.getElementById("sourceLink");
    sourceText.textContent = content.source || "";
    sourceText.classList.toggle("hidden", !content.source);
    sourceLink.classList.add("hidden");
    sourceBox.classList.toggle("hidden", !content.source);

    showScreen("fishView");

    try {
      const viewer = await loadViewer3d();
      const model = await viewer.loadModel(`Assets/Models/${content.model}`);
      viewer.setupScene(model);

      setTimeout(() => {
        const hint = document.getElementById("modelOverlayHint");
        if (hint) hint.classList.add("fade-out");
      }, 4000);
    } catch (modelErr) {
      console.error("3D-Modell konnte nicht geladen werden:", modelErr);
      showModelUnavailable(
        "Das 3D-Modell konnte nicht geladen werden. Die Informationen und das Quiz stehen trotzdem zur Verfügung."
      );
    }
  } catch (e) {
    console.error(e);
    showError(`Fehler beim Laden von ${stripMarkdown(content.name)}: ${e.message || e}`);
  }
}

function parseMarkdown(md) {
  if (!md) return "";
  return window.marked
    ? window.marked.parse(md, { breaks: true })
    : escapeHtml(md).replace(/\n/g, "<br>");
}

function splitMarkdownSections(textRaw) {
  if (!/^##\s+/m.test(textRaw)) {
    return { intro: "", sections: [] };
  }

  const firstHeading = textRaw.search(/^##\s+/m);
  const intro = firstHeading > 0 ? textRaw.slice(0, firstHeading).trim() : "";
  const rest = textRaw.slice(firstHeading);

  const sections = rest
    .split(/^##\s+/m)
    .filter((part) => part.trim())
    .map((part) => {
      const newline = part.indexOf("\n");
      const title = newline >= 0 ? part.slice(0, newline).trim() : part.trim();
      const body = newline >= 0
        ? part.slice(newline + 1).replace(/^\*{3}\s*$/gm, "").trim()
        : "";
      return { title, body };
    });

  return { intro, sections };
}

function linkifyContent(root) {
  root.querySelectorAll("a").forEach((a) => {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  });
}

function isCaptionLine(line) {
  return /\b(?:Bild|Foto|Visualisierung|Darstellung)\s*:/i.test(line);
}

function isSectionHeading(line) {
  return /^[\p{Extended_Pictographic}\uFE0F\u200D]/u.test(line);
}

function parseInlineMarkdown(md) {
  if (!md) return "";
  if (!window.marked) {
    return escapeHtml(md);
  }
  const html = window.marked.parse(md, { breaks: false });
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  const p = tmp.querySelector("p");
  return p ? p.innerHTML : tmp.innerHTML;
}

function prepareInfoText(textRaw) {
  const lines = textRaw.replace(/\r/g, "").split("\n");
  const quizStart = lines.findIndex((line) => /^(?:Kleines Quiz|Quiz:)/i.test(line.trim()));
  const contentLines = quizStart >= 0 ? lines.slice(0, quizStart) : lines.slice();

  while (contentLines.length && !contentLines[0].trim()) contentLines.shift();
  if (contentLines.length) contentLines.shift();

  return contentLines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || isCaptionLine(trimmed) || /^Quellen:/i.test(trimmed)) return "";
    if (/^[•\-]\s+/.test(trimmed)) return `- ${trimmed.replace(/^[•\-]\s+/, "")}`;
    if (isSectionHeading(trimmed)) return `## ${trimmed}`;
    return trimmed;
  }).join("\n");
}

function renderInfoMedia(images = []) {
  if (!images.length) return "";
  return `<div class="info-media">${images.map((image) => `
    <figure class="info-figure">
      <img src="Assets/Images/${escapeHtml(image.file)}" alt="${escapeHtml(image.alt || "")}" loading="lazy">
      ${image.caption ? `<figcaption>${parseInlineMarkdown(image.caption)}</figcaption>` : ""}
    </figure>
  `).join("")}</div>`;
}

function renderInfoText(textRaw, images) {
  const container = document.getElementById("textContent");
  const mediaHtml = renderInfoMedia(images);
  const { intro, sections } = splitMarkdownSections(prepareInfoText(textRaw));

  if (!sections.length) {
    container.innerHTML = `${mediaHtml}<div class="iwm-markdown">${parseMarkdown(textRaw)}</div>`;
    linkifyContent(container);
    return;
  }

  const parts = [mediaHtml, '<div class="fish-text-accordion">'];

  if (intro) {
    parts.push(`<div class="fish-text-intro iwm-markdown">${parseMarkdown(intro)}</div>`);
  }

  sections.forEach((section, index) => {
    const openAttr = index === 0 ? " open" : "";
    parts.push(`
      <details class="fish-accordion"${openAttr}>
        <summary class="fish-accordion-summary">
          <span class="fish-accordion-title">${parseInlineMarkdown(section.title)}</span>
          <span class="fish-accordion-icon" aria-hidden="true"></span>
        </summary>
        <div class="fish-accordion-body iwm-markdown">${parseMarkdown(section.body)}</div>
      </details>
    `);
  });

  parts.push("</div>");
  container.innerHTML = parts.join("");
  linkifyContent(container);
}

function renderQuiz(quiz) {
  const section = document.getElementById("quizSection");
  const container = document.getElementById("quizContent");
  const resultEl = document.getElementById("quizResult");

  if (!quiz?.length) {
    section.classList.add("hidden");
    container.innerHTML = "";
    resultEl.classList.add("hidden");
    return;
  }

  section.classList.remove("hidden");
  resultEl.classList.add("hidden");
  resultEl.innerHTML = "";

  const state = { answered: 0, correct: 0 };

  container.innerHTML = quiz.map((item, qIndex) => `
    <div class="quiz-question" data-q="${qIndex}">
      <p class="quiz-question-text">
        <span class="quiz-number">${qIndex + 1}.</span>
        ${escapeHtml(item.question)}
      </p>
      <div class="quiz-options" role="group" aria-label="Antwortmöglichkeiten">
        ${item.options.map((option, oIndex) => `
          <button type="button" class="quiz-option" data-q="${qIndex}" data-o="${oIndex}">
            ${escapeHtml(option)}
          </button>
        `).join("")}
      </div>
      <p class="quiz-feedback hidden" data-feedback="${qIndex}"></p>
    </div>
  `).join("");

  container.querySelectorAll(".quiz-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      const qIndex = Number(btn.dataset.q);
      const oIndex = Number(btn.dataset.o);
      const question = quiz[qIndex];
      const questionEl = container.querySelector(`.quiz-question[data-q="${qIndex}"]`);
      const feedbackEl = container.querySelector(`[data-feedback="${qIndex}"]`);
      const options = questionEl.querySelectorAll(".quiz-option");

      if (questionEl.classList.contains("answered")) return;

      questionEl.classList.add("answered");
      state.answered += 1;
      const isCorrect = oIndex === question.correct;
      if (isCorrect) state.correct += 1;

      options.forEach((opt, idx) => {
        opt.disabled = true;
        if (idx === question.correct) opt.classList.add("correct");
        else if (idx === oIndex) opt.classList.add("wrong");
      });

      feedbackEl.textContent = isCorrect
        ? `✓ Richtig! ${question.explanation || ""}`
        : `✗ Leider falsch. ${question.explanation || ""}`;
      feedbackEl.classList.remove("hidden");
      feedbackEl.classList.add(isCorrect ? "is-correct" : "is-wrong");

      if (state.answered === quiz.length) {
        showQuizResult(resultEl, state.correct, quiz.length);
      }
    });
  });
}

function showQuizResult(el, correct, total) {
  const pct = Math.round((correct / total) * 100);
  let message;
  if (correct === total) {
    message = "Perfekt! Du kennst dich bestens aus.";
  } else if (correct >= total / 2) {
    message = "Gut gemacht! Lies die Infos noch einmal für die Details.";
  } else {
    message = "Noch Luft nach oben – schau dir die Abschnitte oben noch einmal an.";
  }

  el.innerHTML = `
    <p class="quiz-score">${correct} von ${total} richtig (${pct}%)</p>
    <p class="quiz-score-msg">${message}</p>
    <button type="button" class="iwm-btn-outline iwm-btn-sm" id="quizRetryBtn">Nochmal versuchen</button>
  `;
  el.classList.remove("hidden");

  document.getElementById("quizRetryBtn").addEventListener("click", () => {
    if (activeQuiz) renderQuiz(activeQuiz);
  });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ───── Fehler ─────
function showError(msg) {
  document.getElementById("errorMsg").textContent = msg;
  showScreen("error");
}

// ───── Event Handlers ─────
document.getElementById("startScanBtn").addEventListener("click", startScan);

confirmScanBtn.addEventListener("click", confirmScan);

document.getElementById("cancelScanBtn").addEventListener("click", async () => {
  await stopScan();
  showScreen("welcome");
});

rescanBtn.addEventListener("click", async () => {
  disposeViewerScene();
  await startScan();
});

document.getElementById("errorBackBtn").addEventListener("click", async () => {
  await stopScan();
  disposeViewerScene();
  showScreen("welcome");
});

document.getElementById("resetViewBtn").addEventListener("click", () => {
  viewer3d?.resetView();
});

// ───── Start ─────
window.addEventListener("DOMContentLoaded", async () => {
  try {
    await loadConfig();
  } catch {
    return;
  }
});
