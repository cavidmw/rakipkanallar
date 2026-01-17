/* ===========================
   Rakip Kanal Sıralaması
   - Firebase Firestore (realtime)
   - YouTube Data API v3 (channel info)
   - 3 cluster: green / yellow / red
   - Modes: view (izleme) / edit (düzenleme)
   - Add modal: link + color (required) + description (optional)
   - In view mode: only watch, no edits
   - In edit mode: color change, delete, drag reorder (within same cluster)
   =========================== */

/* ---------- Firebase (module imports) ---------- */
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import {
  getFirestore,
  collection,
  addDoc,
  deleteDoc,
  doc,
  updateDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

/* ---------- YOUR CONFIGS ---------- */
const firebaseConfig = {
  apiKey: "AIzaSyBy7DShn5TQQMEyPitUZ-9A-o6u0EgD08o",
  authDomain: "yt-sayt.firebaseapp.com",
  projectId: "yt-sayt",
  storageBucket: "yt-sayt.firebasestorage.app",
  messagingSenderId: "614904562607",
  appId: "1:614904562607:web:f352a57fe3f4457077e55a"
};

// YouTube Data API key (same as you used)
const YT_API_KEY = "AIzaSyCtw_vK-v4WFXqhoKLmimhFNHoQgJ6r48g";

/* ---------- Init ---------- */
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const channelsRef = collection(db, "channels");

/* ---------- DOM ---------- */
const addOpenBtn = document.getElementById("addOpenBtn");
const editToggleBtn = document.getElementById("editToggleBtn");
const modePill = document.getElementById("modePill");
const collapseBtn = document.getElementById("collapseBtn");

const clusters = document.querySelectorAll(".cluster");
const panel = document.getElementById("panel");
const activeChip = document.getElementById("activeChip");
const panelHint = document.getElementById("panelHint");

const channelList = document.getElementById("channelList");
const emptyState = document.getElementById("emptyState");

const countGreen = document.getElementById("countGreen");
const countYellow = document.getElementById("countYellow");
const countRed = document.getElementById("countRed");

const modalBackdrop = document.getElementById("modalBackdrop");
const addModal = document.getElementById("addModal");
const addCloseBtn = document.getElementById("addCloseBtn");
const cancelAddBtn = document.getElementById("cancelAddBtn");
const saveAddBtn = document.getElementById("saveAddBtn");

const channelLinkEl = document.getElementById("channelLink");
const channelDescEl = document.getElementById("channelDesc");

const tpl = document.getElementById("channelItemTpl");

/* ---------- State ---------- */
const CLUSTER_LABEL = {
  green: "EN ALAKALI",
  yellow: "ORTA ALAKALI",
  red: "AZ ALAKALI"
};

let activeCluster = "green";
let mode = "view"; // "view" | "edit"
let allDocs = [];  // { id, data }

/* Drag state */
let draggedId = null;

/* ---------- Helpers ---------- */
function setMode(newMode) {
  mode = newMode;
  document.body.classList.toggle("is-edit", mode === "edit");
  document.body.classList.toggle("is-view", mode !== "edit");

  modePill.classList.toggle("is-edit", mode === "edit");
  const modeText = modePill.querySelector(".mode-text");
  modeText.textContent = mode === "edit" ? "Düzenleme modu" : "İzleme modu";

  // Edit buton yazısı (küçük UX)
  const txt = editToggleBtn.querySelector(".btn__text");
  txt.textContent = mode === "edit" ? "Bitir" : "Düzenle";

  // Dragging only in edit
  refreshRender();
}

function setActiveCluster(cluster) {
  activeCluster = cluster;

  clusters.forEach(btn => btn.classList.toggle("is-active", btn.dataset.cluster === cluster));

  activeChip.textContent = CLUSTER_LABEL[cluster] || "KÜME";
  panelHint.textContent = "Bu kümedeki kanallar burada listelenir.";

  // Panel görünür kalsın
  panel.classList.remove("is-collapsed");
  refreshRender();
}

function openModal() {
  modalBackdrop.hidden = false;
  addModal.hidden = false;

  modalBackdrop.style.display = "block";
  addModal.style.display = "grid";

  document.body.style.overflow = "hidden";

  setTimeout(() => channelLinkEl.focus(), 0);
}

function closeModal() {
  modalBackdrop.hidden = true;
  addModal.hidden = true;

  modalBackdrop.style.display = "none";
  addModal.style.display = "none";

  document.body.style.overflow = "";

  channelLinkEl.value = "";
  channelDescEl.value = "";

  const pickGreen = document.getElementById("pickGreen");
  if (pickGreen) pickGreen.checked = true;
}

function getPickedColor() {
  const picked = document.querySelector('input[name="colorPick"]:checked');
  const val = (picked?.value || "green").trim();
  if (val === "green" || val === "yellow" || val === "red") return val;
  return "green";
}

function formatSubs(n) {
  const num = Number(n || 0);
  return `${num.toLocaleString("tr-TR")} abone`;
}

function safeText(s, max = 160) {
  const t = String(s ?? "").trim();
  if (!t) return "";
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/* YouTube channel URL build */
function youtubeChannelUrl(channelId) {
  return `https://www.youtube.com/channel/${encodeURIComponent(channelId)}`;
}

/* ---------- YouTube parsing ---------- */
async function extractChannelId(url) {
  const u = String(url || "").trim();

  // /channel/UCxxxx
  const channelMatch = u.match(/channel\/([A-Za-z0-9_-]{10,})/);
  if (channelMatch) return channelMatch[1];

  // /@handle
  const handleMatch = u.match(/\/@([A-Za-z0-9._-]+)/);
  if (handleMatch) {
    const handle = handleMatch[1];
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=${encodeURIComponent(handle)}&maxResults=1&key=${YT_API_KEY}`
    );
    if (!res.ok) return null;
    const json = await res.json();
    if (json.items && json.items.length > 0) {
      return json.items[0]?.snippet?.channelId || null;
    }
  }

  // custom URLs might not be resolvable reliably with this method
  return null;
}

async function fetchChannelData(channelId) {
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${encodeURIComponent(channelId)}&key=${YT_API_KEY}`
  );
  if (!res.ok) throw new Error("YouTube API hatası");
  const json = await res.json();
  const ch = json?.items?.[0];
  if (!ch) throw new Error("Kanal bulunamadı");

  const title = ch?.snippet?.title || "Bilinmeyen Kanal";
  const thumb =
    ch?.snippet?.thumbnails?.high?.url ||
    ch?.snippet?.thumbnails?.medium?.url ||
    ch?.snippet?.thumbnails?.default?.url ||
    "";

  const subs = Number(ch?.statistics?.subscriberCount || 0);

  return {
    channelId,
    name: title,
    logo: thumb,
    subs
  };
}

/* ---------- Firestore model ----------
   doc fields:
   - channelId, name, logo, subs
   - color: green|yellow|red  (required)
   - desc: string (optional)
   - order: number  (ordering inside color group)
   - createdAt: serverTimestamp
------------------------------------------------ */

/* ---------- Add channel ---------- */
async function addChannelFlow() {
  const link = channelLinkEl.value.trim();
  const desc = safeText(channelDescEl.value, 220);
  const color = getPickedColor();

  if (!link) {
    alert("Lütfen YouTube kanal linki gir.");
    channelLinkEl.focus();
    return;
  }

  saveAddBtn.disabled = true;
  saveAddBtn.textContent = "Kaydediliyor...";

  try {
    const channelId = await extractChannelId(link);
    if (!channelId) {
      alert("Geçerli bir YouTube kanal linki gir. (channel/.. veya @handle)");
      return;
    }

    const data = await fetchChannelData(channelId);

    // prevent duplicates by channelId (soft check: client side)
    const exists = allDocs.some(d => d.data?.channelId === channelId);
    if (exists) {
      alert("Bu kanal zaten ekli görünüyor.");
      return;
    }

    // order: place to end of its color group
    const maxOrder = getMaxOrderForColor(color);
    const order = maxOrder + 1;

    await addDoc(channelsRef, {
      ...data,
      desc: desc || "",
      color,
      order,
      createdAt: serverTimestamp()
    });

    closeModal();
    setMode("view"); // kaydet sonrası izleme moduna geç
  } catch (err) {
    console.error(err);
    alert("Kanal eklenemedi. Linki kontrol et veya API anahtarını kontrol et.");
  } finally {
    saveAddBtn.disabled = false;
    saveAddBtn.textContent = "Kaydet";
  }
}

function getMaxOrderForColor(color) {
  let max = -1;
  for (const d of allDocs) {
    if (d?.data?.color === color) {
      const o = Number(d?.data?.order ?? 0);
      if (o > max) max = o;
    }
  }
  return max;
}

/* ---------- Render ---------- */
function refreshCounts() {
  const g = allDocs.filter(d => d.data.color === "green").length;
  const y = allDocs.filter(d => d.data.color === "yellow").length;
  const r = allDocs.filter(d => d.data.color === "red").length;
  countGreen.textContent = String(g);
  countYellow.textContent = String(y);
  countRed.textContent = String(r);
}

function getActiveListSorted() {
  return allDocs
    .filter(d => d.data.color === activeCluster)
    .slice()
    .sort((a, b) => Number(a.data.order ?? 0) - Number(b.data.order ?? 0));
}

function refreshEmptyState(itemsLen) {
  if (itemsLen === 0) {
    emptyState.classList.add("is-show");
  } else {
    emptyState.classList.remove("is-show");
  }
}

function makeItemElement(docObj, index) {
  const { id, data } = docObj;
  const node = tpl.content.firstElementChild.cloneNode(true);

  node.dataset.id = id;
  node.dataset.color = data.color || "green";
  node.draggable = mode === "edit";

  const numEl = node.querySelector(".item__num");
  const logoEl = node.querySelector(".item__logo");
  const nameEl = node.querySelector(".item__name");
  const subsEl = node.querySelector(".item__subs");
  const descEl = node.querySelector(".item__desc");
  const selectEl = node.querySelector(".item__select");
  const delBtn = node.querySelector(".item__del");
  const dragHandle = node.querySelector(".drag-handle");

  numEl.textContent = String(index + 1);

  logoEl.src = data.logo || "";
  logoEl.alt = `${data.name || "Kanal"} logosu`;

  nameEl.textContent = data.name || "Bilinmeyen Kanal";
  nameEl.href = youtubeChannelUrl(data.channelId);

  subsEl.textContent = formatSubs(data.subs);

  const desc = safeText(data.desc, 120);
  if (desc) {
    descEl.textContent = desc;
    descEl.style.display = "";
  } else {
    descEl.textContent = "";
    descEl.style.display = "none";
  }

  // select
  selectEl.value = data.color || "green";
  selectEl.disabled = mode !== "edit";

  // delete
  delBtn.disabled = mode !== "edit";

  // hide drag handle in view handled by css, but keep pointer blocked anyway
  dragHandle.style.pointerEvents = mode === "edit" ? "auto" : "none";

  // change color (moves to cluster)
  selectEl.addEventListener("change", async (e) => {
    if (mode !== "edit") return;
    const newColor = e.target.value;
    if (!["green", "yellow", "red"].includes(newColor)) return;

    try {
      // put at end of new cluster
      const maxOrder = getMaxOrderForColor(newColor);
      await updateDoc(doc(db, "channels", id), { color: newColor, order: maxOrder + 1 });
      // if moved out of active cluster, UI will update via snapshot
    } catch (err) {
      console.error(err);
      alert("Renk değiştirilemedi.");
    }
  });

  // delete
  delBtn.addEventListener("click", async () => {
    if (mode !== "edit") return;
    const ok = confirm("Bu kanalı silmek istiyor musun?");
    if (!ok) return;
    try {
      await deleteDoc(doc(db, "channels", id));
    } catch (err) {
      console.error(err);
      alert("Silinemedi.");
    }
  });

  // drag reorder (only within active cluster)
  addDragEvents(node, dragHandle);

  return node;
}

function refreshRender() {
  refreshCounts();

  const items = getActiveListSorted();
  channelList.innerHTML = "";

  items.forEach((d, idx) => {
    channelList.appendChild(makeItemElement(d, idx));
  });

  refreshEmptyState(items.length);
}

/* ---------- Drag & Drop reorder ---------- */
function addDragEvents(li, handle) {
  // Only in edit mode
  li.addEventListener("dragstart", (e) => {
    if (mode !== "edit") {
      e.preventDefault();
      return;
    }
    // We want drag only when handle is used
    // If user drags elsewhere, block
    if (e.target !== handle) {
      e.preventDefault();
      return;
    }
    draggedId = li.dataset.id;
    li.classList.add("is-dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", draggedId); } catch {}
  });

  li.addEventListener("dragend", () => {
    li.classList.remove("is-dragging");
    draggedId = null;
  });

  li.addEventListener("dragover", (e) => {
    if (mode !== "edit") return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  });

  li.addEventListener("drop", async (e) => {
    if (mode !== "edit") return;
    e.preventDefault();

    const targetId = li.dataset.id;
    const fromId = draggedId || (()=>{
      try { return e.dataTransfer.getData("text/plain"); } catch { return null; }
    })();

    if (!fromId || fromId === targetId) return;

    // Reorder within active cluster only
    const items = getActiveListSorted(); // sorted array of doc objects
    const ids = items.map(x => x.id);

    const fromIndex = ids.indexOf(fromId);
    const toIndex = ids.indexOf(targetId);
    if (fromIndex === -1 || toIndex === -1) return;

    // Move in array
    ids.splice(toIndex, 0, ids.splice(fromIndex, 1)[0]);

    // Update orders sequentially
    // To reduce writes, only update changed indexes
    const updates = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const docObj = items.find(x => x.id === id);
      const currentOrder = Number(docObj?.data?.order ?? 0);
      if (currentOrder !== i) {
        updates.push(updateDoc(doc(db, "channels", id), { order: i }));
      }
    }

    try {
      await Promise.all(updates);
    } catch (err) {
      console.error(err);
      alert("Sıralama kaydedilemedi.");
    }
  });

  // Make handle the only draggable start point
  // This improves UX: user can still click name etc.
  handle.addEventListener("mousedown", () => {
    // no-op: just exists so user feels it's the handle
  });
}

/* ---------- Panel collapse ---------- */
function collapsePanel() {
  panel.classList.add("is-collapsed");
  clusters.forEach(btn => btn.classList.remove("is-active"));
}

/* ---------- Events ---------- */
addOpenBtn.addEventListener("click", () => {
  openModal();
});

editToggleBtn.addEventListener("click", () => {
  setMode(mode === "edit" ? "view" : "edit");
});

collapseBtn.addEventListener("click", () => {
  collapsePanel();
});

clusters.forEach(btn => {
  btn.addEventListener("click", () => setActiveCluster(btn.dataset.cluster));
});

modalBackdrop.addEventListener("click", closeModal);
addCloseBtn.addEventListener("click", closeModal);
cancelAddBtn.addEventListener("click", closeModal);

saveAddBtn.addEventListener("click", addChannelFlow);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!addModal.hidden) closeModal();
  }
});

/* ---------- Realtime listener ---------- */
const q = query(channelsRef, orderBy("order"));
onSnapshot(
  q,
  (snapshot) => {
    allDocs = snapshot.docs.map(d => ({
      id: d.id,
      data: d.data()
    }));

    // Güvenlik: eksik alanları normalize et
    for (const d of allDocs) {
      if (!["green", "yellow", "red"].includes(d.data.color)) d.data.color = "green";
      if (typeof d.data.order !== "number") d.data.order = 0;
      if (typeof d.data.subs !== "number") d.data.subs = Number(d.data.subs || 0);
      if (typeof d.data.desc !== "string") d.data.desc = d.data.desc ? String(d.data.desc) : "";
    }

    refreshRender();
  },
  (err) => {
    console.error("Firestore onSnapshot error:", err);
    alert("Firestore veri çekme hatası! (Muhtemelen index/rules). Konsolu kontrol et.");
  }
);

  // Normalize missing fields (safety)
  for (const d of allDocs) {
    if (!["green", "yellow", "red"].includes(d.data.color)) d.data.color = "green";
    if (typeof d.data.order !== "number") d.data.order = 0;
  }

  refreshRender();
;

/* ---------- Init defaults ---------- */
setMode("view");
setActiveCluster("green");
closeModal(); // ensure hidden state (in case)

closeModal();