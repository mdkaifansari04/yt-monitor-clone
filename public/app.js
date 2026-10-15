// YouTube Monitor Clone — tiny SPA, no framework.

const app = document.getElementById("app");

// ---------- helpers ----------

const icon = {
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  like: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v11"/><path d="M15 5.9 14 10h5.8a2 2 0 0 1 2 2.3l-1.4 7A2 2 0 0 1 18.4 21H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h2.8a2 2 0 0 0 1.7-1L12 3a3.1 3.1 0 0 1 3 2.9z"/></svg>',
  comment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M8 16H3v5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  sliders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><path d="M15 4v4M9 10v4M17 16v4"/></svg>',
  chevron: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  trend: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
  arrow: '<svg class="arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const fmt = (n) => (n == null ? "—" : compact.format(n));
const full = new Intl.NumberFormat("en");

function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

async function api(path, opts = {}, retried = false) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { "content-type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  // Every response from our worker is JSON. Anything else is a Cloudflare edge
  // error (e.g. "error code: 1042") that never reached it, so one retry is safe.
  if (!retried && !res.ok && !(res.headers.get("content-type") ?? "").includes("json")) {
    await new Promise((r) => setTimeout(r, 600));
    return api(path, opts, true);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, error = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), 3200);
}

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

const ytThumb = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
const variantThumb = (id, hash) => `/api/thumb/${id}/${hash}`;
const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;
const channelUrl = (c) =>
  esc(c.handle ? `https://www.youtube.com/${encodeURI(c.handle)}` : `https://www.youtube.com/channel/${c.channel_id ?? c.id}`);

// ---------- state ----------

const ACTIVITY = [
  ["new_video", "New videos"],
  ["title_change", "Title changes"],
  ["thumb_change", "Thumbnail swaps"],
  ["ab_test", "A/B tests started"],
  ["ab_test_done", "A/B tests finished"],
  ["milestone", "Subscriber milestones"],
];

const VIEW_STEPS = [0, 1000, 10000, 50000, 100000, 1000000];

const state = {
  settings: null,
  channels: null,
  filters: store.get("filters", { minViews: 0, types: [], channels: [], hideWatched: false, shorts: false }),
  openSections: store.get("openSections", ["show"]),
  filtersCollapsed: store.get("filtersCollapsed", false),
  feed: null,
  days: null,
};

function saveFilters() {
  store.set("filters", state.filters);
}

// ---------- router ----------

const routes = { "/": renderFeed, "/channels": renderChannels, "/settings": renderSettings };

function navigate(path, push = true) {
  if (push) history.pushState({}, "", path);
  const route = routes[location.pathname] ? location.pathname : "/";
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", a.getAttribute("href") === route));
  window.scrollTo(0, 0);
  routes[route]();
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link]");
  if (a && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    navigate(a.getAttribute("href"));
  }
});
window.addEventListener("popstate", () => navigate(location.pathname, false));

async function loadSettings() {
  if (!state.settings) state.settings = await api("/api/settings");
  return state.settings;
}

async function loadChannels(force = false) {
  if (!state.channels || force) state.channels = (await api("/api/channels")).channels;
  return state.channels;
}

// ---------- feed page ----------

function pageHead({ kicker, title, text, action = "" }) {
  return `
    <div class="page-head">
      <div>
        <div class="kicker">${kicker}</div>
        <h1>${title}</h1>
        <p>${text}</p>
      </div>
      ${action}
    </div>`;
}

async function renderFeed() {
  app.innerHTML = `
    ${pageHead({
      kicker: "the rival watchlist 👀",
      title: "Feed",
      text: "New videos, title rewrites, thumbnail swaps, and channel rebrands across the channels you watch.",
      action: `<button class="btn" id="refresh">${icon.refresh}Refresh feed</button>`,
    })}
    <div class="layout">
      <aside class="sidebar">
        <section class="card quick-add">
          <div class="panel-head">${icon.plus}<u>Quick add channel</u></div>
          <div class="panel-body">
            <form id="quick-add">
              <input class="input" name="input" placeholder="@channel or URL" autocomplete="off" required />
              <button class="add-btn" aria-label="Add channel">${icon.plus}</button>
            </form>
            <p class="hint" id="slots"></p>
          </div>
        </section>
        <section class="card filters ${state.filtersCollapsed ? "collapsed" : ""}" id="filters"></section>
      </aside>
      <section class="feed" id="feed"><div class="card skeleton"></div><div class="card skeleton"></div></section>
    </div>`;

  document.getElementById("refresh").addEventListener("click", onRefresh);
  document.getElementById("quick-add").addEventListener("submit", onAddChannel);

  try {
    const [settings, channels] = await Promise.all([loadSettings(), loadChannels()]);
    if (!state.days) state.days = settings.feedDays;
    document.getElementById("slots").textContent = `${channels.length} channel${channels.length === 1 ? "" : "s"} watched · unlimited slots`;
    renderFilters();
    await loadFeed();
  } catch (e) {
    document.getElementById("feed").innerHTML = `<div class="card empty"><h3>Couldn't load the feed</h3><p>${esc(e.message)}</p></div>`;
  }
}

function renderFilters() {
  const el = document.getElementById("filters");
  if (!el) return;
  const f = state.filters;
  const open = (k) => (state.openSections.includes(k) ? "open" : "");
  const channels = state.channels ?? [];

  el.innerHTML = `
    <button class="panel-head" data-collapse>${icon.sliders}Filters${icon.chevron}</button>
    ${
      state.filtersCollapsed
        ? ""
        : `
    <div class="filter-section ${open("show")}" data-section="show">
      <button class="filter-toggle">Show${icon.chevron}</button>
      <div class="filter-content">
        <label class="check"><input type="checkbox" data-flag="hideWatched" ${f.hideWatched ? "checked" : ""}/>Hide watched videos</label>
        <label class="check"><input type="checkbox" data-flag="shorts" ${f.shorts ? "checked" : ""}/>Include Shorts</label>
      </div>
    </div>
    <div class="filter-section ${open("views")}" data-section="views">
      <button class="filter-toggle">Views${f.minViews ? ` · ${fmt(f.minViews)}+` : ""}${icon.chevron}</button>
      <div class="filter-content chips">
        ${VIEW_STEPS.map((v) => `<button class="chip ${f.minViews === v ? "on" : ""}" data-views="${v}">${v ? `${fmt(v)}+` : "Any"}</button>`).join("")}
      </div>
    </div>
    <div class="filter-section ${open("types")}" data-section="types">
      <button class="filter-toggle">Activity types${f.types.length ? ` · ${f.types.length}` : ""}${icon.chevron}</button>
      <div class="filter-content">
        ${ACTIVITY.map(([k, label]) => `<label class="check"><input type="checkbox" data-type="${k}" ${f.types.includes(k) ? "checked" : ""}/>${label}</label>`).join("")}
      </div>
    </div>
    <div class="filter-section ${open("channels")}" data-section="channels">
      <button class="filter-toggle">Channels · ${f.channels.length} selected${icon.chevron}</button>
      <div class="filter-content">
        ${
          channels.length
            ? channels
                .map(
                  (c) => `<label class="check"><input type="checkbox" data-channel="${c.id}" ${f.channels.includes(c.id) ? "checked" : ""}/>
                  ${c.avatar_url ? `<img src="${esc(c.avatar_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}
                  <span class="grow">${esc(c.title)}</span></label>`,
                )
                .join("")
            : `<p class="hint" style="margin:0">No channels yet.</p>`
        }
        ${f.channels.length ? `<button class="link-btn" data-clear-channels>Clear selection</button>` : ""}
      </div>
    </div>`
    }`;

  el.onclick = (e) => {
    if (e.target.closest("[data-collapse]")) {
      state.filtersCollapsed = !state.filtersCollapsed;
      store.set("filtersCollapsed", state.filtersCollapsed);
      el.classList.toggle("collapsed", state.filtersCollapsed);
      return renderFilters();
    }
    const toggle = e.target.closest(".filter-toggle");
    if (toggle) {
      const section = toggle.parentElement;
      section.classList.toggle("open");
      const k = section.dataset.section;
      state.openSections = section.classList.contains("open")
        ? [...state.openSections, k]
        : state.openSections.filter((s) => s !== k);
      store.set("openSections", state.openSections);
      return;
    }
    const chip = e.target.closest("[data-views]");
    if (chip) {
      f.minViews = Number(chip.dataset.views);
      return applyFilters();
    }
    if (e.target.closest("[data-clear-channels]")) {
      f.channels = [];
      return applyFilters();
    }
  };
  el.onchange = (e) => {
    const t = e.target;
    if (t.dataset.flag) f[t.dataset.flag] = t.checked;
    if (t.dataset.type) f.types = t.checked ? [...f.types, t.dataset.type] : f.types.filter((x) => x !== t.dataset.type);
    if (t.dataset.channel)
      f.channels = t.checked ? [...f.channels, t.dataset.channel] : f.channels.filter((x) => x !== t.dataset.channel);
    applyFilters();
  };
}

function applyFilters() {
  saveFilters();
  renderFilters();
  loadFeed();
}

async function loadFeed() {
  const f = state.filters;
  const qs = new URLSearchParams({ days: state.days });
  if (f.types.length) qs.set("types", f.types.join(","));
  if (f.channels.length) qs.set("channels", f.channels.join(","));
  if (f.minViews) qs.set("minViews", f.minViews);
  if (f.hideWatched) qs.set("hideWatched", "1");
  if (f.shorts) qs.set("shorts", "1");
  state.feed = await api(`/api/feed?${qs}`);
  drawFeed();
}

function drawFeed() {
  const el = document.getElementById("feed");
  if (!el) return;
  const { events, toWatch, days } = state.feed;

  if (!state.channels.length) {
    el.innerHTML = `
      <div class="card empty">
        <span class="eyes"><i></i><i></i></span>
        <h3>Nobody to watch yet</h3>
        <p>Add a channel with its @handle or URL and its recent uploads land here.</p>
        <button class="btn btn-red" onclick="document.querySelector('#quick-add input').focus()">${icon.plus}Add your first channel</button>
      </div>`;
    return;
  }

  const meta = `
    <div class="feed-meta">
      <span class="to-watch"><b>${toWatch}</b> ${toWatch === 1 ? "video" : "videos"} to watch from the last ${days} days</span>
      ${toWatch ? `<button class="btn btn-small" id="watch-all">${icon.check}Mark all watched</button>` : ""}
    </div>`;

  const extend = [3, 7, 10, 30].filter((d) => d > days).slice(0, 2);
  const banner = `
    <div class="card end-banner">
      <h3>That's everything from the last ${days} days</h3>
      <p>${extend.length ? "Want to dig further back? History is kept for 60 days." : "You're looking at your full history window."}</p>
      <div class="row">
        ${extend.map((d, i) => `<button class="btn ${i === 0 ? "btn-red" : ""}" data-days="${d}">Show ${d} days</button>`).join("")}
        ${days !== state.settings.feedDays ? `<button class="btn" data-days="${state.settings.feedDays}">Back to ${state.settings.feedDays} days</button>` : ""}
      </div>
    </div>`;

  el.innerHTML =
    meta +
    (events.length
      ? events.map(renderEvent).join("")
      : `<div class="card empty"><h3>All quiet</h3><p>No activity matches these filters in the last ${days} days.</p></div>`) +
    banner;

  el.onclick = async (e) => {
    const dayBtn = e.target.closest("[data-days]");
    if (dayBtn) {
      state.days = Number(dayBtn.dataset.days);
      return loadFeed();
    }
    const w = e.target.closest("[data-watch]");
    if (w) return toggleWatched(w.dataset.watch, w.dataset.watched !== "1");
    if (e.target.closest("#watch-all")) {
      try {
        const r = await api("/api/videos/watch-all", { method: "POST", body: { days: state.days } });
        toast(`Marked ${r.updated} video${r.updated === 1 ? "" : "s"} as watched`);
        await loadFeed();
      } catch (err) {
        toast(err.message, true);
      }
    }
  };
}

function timePill(ts) {
  return `<span class="time" title="${new Date(ts).toLocaleString()}">${icon.clock}${ago(ts)}</span>`;
}

function stats(ev) {
  return `
    <div class="stats">
      ${ev.views != null ? `<span class="stat views">${icon.eye}${fmt(ev.views)} <small>views</small></span>` : ""}
      ${ev.likes != null ? `<span class="stat likes">${icon.like}${fmt(ev.likes)} <small>likes</small></span>` : ""}
      ${ev.comments != null ? `<span class="stat comments">${icon.comment}${fmt(ev.comments)} <small>comments</small></span>` : ""}
    </div>`;
}

function thumbImg(src, alt, extra = "", tag = "") {
  return `<div class="thumb ${extra}">${tag ? `<span class="tag">${tag}</span>` : ""}<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" referrerpolicy="no-referrer"></div>`;
}

function renderEvent(ev) {
  const who = `<a href="${channelUrl(ev)}" target="_blank" rel="noopener">${esc(ev.channel_title)}</a>`;
  const vid = ev.video_id;
  const title = ev.video_title ?? ev.data.title ?? "";
  const watched = Boolean(ev.watched_at);
  const watchBtn = vid
    ? `<button class="btn btn-small watch-toggle ${watched ? "on" : ""}" data-watch="${vid}" data-watched="${watched ? 1 : 0}">
         ${watched ? `${icon.check}Watched` : `${icon.eye}Mark watched`}</button>`
    : "";

  let head = "";
  let bodyHtml = "";

  switch (ev.type) {
    case "new_video":
      head = `${who} uploaded a new video!`;
      bodyHtml = `
        <div class="video-row">
          <a href="${watchUrl(vid)}" target="_blank" rel="noopener">${thumbImg(ytThumb(vid), title, "", ev.is_short ? "SHORT" : "")}</a>
          <div class="video-info">
            <a class="video-title" href="${watchUrl(vid)}" target="_blank" rel="noopener">${esc(title)}</a>
            ${stats(ev)}
          </div>
        </div>`;
      break;
    case "title_change":
      head = `${who} rewrote a video's title`;
      bodyHtml = `
        <div class="video-row">
          <a href="${watchUrl(vid)}" target="_blank" rel="noopener">${thumbImg(ytThumb(vid), title)}</a>
          <div class="title-diff">
            <span class="old">${esc(ev.data.from)}</span>
            <span class="new">${esc(ev.data.to)}</span>
            ${stats(ev)}
          </div>
        </div>`;
      break;
    case "thumb_change":
      head = `${who} swapped a video's thumbnail`;
      bodyHtml = `
        <p class="event-sub">New thumbnail on <q>${esc(title)}</q></p>
        <div class="swap">
          ${thumbImg(variantThumb(vid, ev.data.from), "Old thumbnail", "old", "OLD")}
          ${icon.arrow}
          <a href="${watchUrl(vid)}" target="_blank" rel="noopener">${thumbImg(variantThumb(vid, ev.data.to), "New thumbnail", "", "NEW")}</a>
        </div>`;
      break;
    case "ab_test": {
      const n = ev.data.variants?.length ?? 0;
      const live = ev.thumb_state === "testing";
      head = `${who} ${live ? "is A/B testing" : "A/B tested"} a video's thumbnail`;
      bodyHtml = `
        <p class="event-sub">Rotating between ${n} thumbnails on <q>${esc(title)}</q></p>
        <div class="thumb-grid">${(ev.data.variants ?? []).map((h, i) => thumbImg(variantThumb(vid, h), `Variant ${i + 1}`)).join("")}</div>`;
      break;
    }
    case "ab_test_done": {
      const variants = ev.data.variants ?? [];
      const ordered = [ev.data.winner, ...variants.filter((h) => h !== ev.data.winner)];
      head = `${who} finished A/B testing a video's thumbnail`;
      bodyHtml = `
        <p class="event-sub">Settled on a thumbnail for <q>${esc(title)}</q> after testing ${variants.length}</p>
        <div class="thumb-grid settled">${ordered
          .map((h) => thumbImg(variantThumb(vid, h), h === ev.data.winner ? "Winning thumbnail" : "Losing variant", h === ev.data.winner ? "winner" : "", h === ev.data.winner ? "WINNER" : ""))
          .join("")}</div>`;
      break;
    }
    case "milestone": {
      const gain = ev.data.to - ev.data.from;
      head = `${who} crossed a subscriber milestone`;
      bodyHtml = `
        <div class="milestone">
          ${ev.avatar_url ? `<img src="${esc(ev.avatar_url)}" alt="" referrerpolicy="no-referrer">` : ""}
          <div>
            <div class="big-num"><strong>${fmt(ev.data.to)}</strong><span>subscribers</span>
              <span class="gain">${icon.trend}+${full.format(gain)}</span></div>
            <div class="muted" style="margin-top:10px;font-size:17px">up from ${fmt(ev.data.from)}</div>
          </div>
        </div>`;
      break;
    }
    default:
      return "";
  }

  const dim = ev.type === "new_video" && watched ? "watched" : "";
  return `
    <article class="card event ${dim}">
      <div class="event-head"><h2 class="event-title">${head}</h2>${timePill(ev.created_at)}</div>
      ${bodyHtml}
      ${watchBtn}
    </article>`;
}

async function toggleWatched(videoId, watched) {
  try {
    await api(`/api/videos/${videoId}/watched`, { method: "POST", body: { watched } });
    for (const ev of state.feed.events) if (ev.video_id === videoId) ev.watched_at = watched ? Date.now() : null;
    state.feed.toWatch += watched ? -1 : 1;
    if (watched && state.filters.hideWatched) {
      state.feed.events = state.feed.events.filter((ev) => !(ev.type === "new_video" && ev.video_id === videoId));
    }
    drawFeed();
  } catch (e) {
    toast(e.message, true);
  }
}

async function onRefresh(e) {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.classList.add("spin");
  try {
    const r = await api("/api/refresh", { method: "POST" });
    toast(
      r.newEvents
        ? `Checked ${r.channelsChecked} channels · ${r.newEvents} new update${r.newEvents === 1 ? "" : "s"}`
        : `Checked ${r.channelsChecked} channels · nothing new`,
    );
    if (r.errors.length) console.warn(r.errors);
    await loadChannels(true);
    await loadFeed();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.classList.remove("spin");
  }
}

async function onAddChannel(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const input = form.elements.input;
  const btn = form.querySelector("button");
  btn.disabled = true;
  try {
    const r = await api("/api/channels", { method: "POST", body: { input: input.value } });
    toast(`Now watching ${r.title}`);
    input.value = "";
    await loadChannels(true);
    if (location.pathname === "/channels") renderChannels();
    else {
      document.getElementById("slots").textContent = `${state.channels.length} channels watched · unlimited slots`;
      renderFilters();
      await loadFeed();
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ---------- channels page ----------

async function renderChannels() {
  app.innerHTML = `
    ${pageHead({
      kicker: "who you're keeping an eye on",
      title: "Channels",
      text: "Every channel here is checked for new uploads every 15 minutes, and recent thumbnails are sampled hourly.",
    })}
    <section class="card channel-add">
      <form id="quick-add">
        <input class="input" name="input" placeholder="@handle, channel URL or UC… id" autocomplete="off" required />
        <button class="add-btn" aria-label="Add channel">${icon.plus}</button>
      </form>
      <p class="hint" id="slots">Unlimited slots — add as many as you like.</p>
    </section>
    <div class="channel-grid" id="channels"><div class="card skeleton"></div><div class="card skeleton"></div></div>`;
  document.getElementById("quick-add").addEventListener("submit", onAddChannel);

  const grid = document.getElementById("channels");
  try {
    const channels = await loadChannels(true);
    if (!channels.length) {
      grid.innerHTML = `<div class="card empty" style="grid-column:1/-1"><span class="eyes"><i></i><i></i></span><h3>No channels yet</h3><p>Paste a @handle above to start watching.</p></div>`;
      return;
    }
    grid.innerHTML = channels
      .map(
        (c) => `
      <article class="card channel-card">
        ${c.avatar_url ? `<img src="${esc(c.avatar_url)}" alt="" referrerpolicy="no-referrer">` : `<div class="ph"></div>`}
        <div class="info">
          <h3><a href="${channelUrl(c)}" target="_blank" rel="noopener">${esc(c.title)}</a></h3>
          <div class="meta">
            ${c.handle ? `${esc(c.handle)} · ` : ""}${c.subscriber_count != null ? `${fmt(c.subscriber_count)} subscribers` : "subscribers pending"}<br>
            ${c.last_upload_at ? `Last upload ${ago(c.last_upload_at)}` : "No uploads seen"} · ${c.uploads_30d} in 30d<br>
            Checked ${c.last_checked_at ? ago(c.last_checked_at) : "never"}
          </div>
          ${c.last_error ? `<div class="err">${esc(c.last_error)}</div>` : ""}
        </div>
        <button class="icon-btn" data-remove="${c.id}" data-title="${esc(c.title)}" title="Stop watching" aria-label="Remove ${esc(c.title)}">${icon.trash}</button>
      </article>`,
      )
      .join("");
    grid.onclick = async (e) => {
      const b = e.target.closest("[data-remove]");
      if (!b) return;
      if (!confirm(`Stop watching ${b.dataset.title}? Its history in your feed is removed too.`)) return;
      try {
        await api(`/api/channels/${b.dataset.remove}`, { method: "DELETE" });
        state.filters.channels = state.filters.channels.filter((id) => id !== b.dataset.remove);
        saveFilters();
        toast(`Stopped watching ${b.dataset.title}`);
        renderChannels();
      } catch (err) {
        toast(err.message, true);
      }
    };
  } catch (e) {
    grid.innerHTML = `<div class="card empty"><h3>Couldn't load channels</h3><p>${esc(e.message)}</p></div>`;
  }
}

// ---------- settings page ----------

async function renderSettings() {
  app.innerHTML = `
    ${pageHead({ kicker: "knobs & dials", title: "Settings", text: "Single-user mode: no accounts, no limits." })}
    <div class="settings" id="settings"><div class="card skeleton"></div></div>`;
  const el = document.getElementById("settings");
  try {
    const s = (state.settings = await api("/api/settings"));
    el.innerHTML = `
      <section class="card">
        <h2>Feed window</h2>
        <p>How many days of activity the feed shows by default. History is kept for ${s.retentionDays} days.</p>
        <div class="chips" id="days">
          ${[3, 7, 10, 14, 30, 60]
            .filter((d) => d <= s.retentionDays)
            .map((d) => `<button class="chip ${s.feedDays === d ? "on" : ""}" data-days="${d}">${d} days</button>`)
            .join("")}
        </div>
      </section>
      <section class="card">
        <h2>Tracking</h2>
        <p>A Cloudflare cron runs every 5 minutes and works through whatever is due.</p>
        <dl class="kv">
          <dt>Upload checks</dt><dd>every ${s.channelIntervalMin} min per channel</dd>
          <dt>Thumbnail sampling</dt><dd>every ${s.thumbIntervalMin} min, for ${s.thumbTrackDays} days after upload</dd>
          <dt>A/B test ends after</dt><dd>${s.abSettleHours}h showing a single thumbnail</dd>
          <dt>YouTube Data API</dt><dd>${s.apiKey ? "Connected — comments + exact subscriber counts" : "Not set — using public RSS + page data"}</dd>
        </dl>
        ${s.apiKey ? "" : `<p style="margin:16px 0 0">Optional: add a key with <code>npx wrangler secret put YT_API_KEY</code> to get comment counts.</p>`}
      </section>`;
    document.getElementById("days").onclick = async (e) => {
      const b = e.target.closest("[data-days]");
      if (!b) return;
      try {
        const r = await api("/api/settings", { method: "PUT", body: { feedDays: Number(b.dataset.days) } });
        state.settings.feedDays = r.feedDays;
        state.days = r.feedDays;
        toast(`Feed now shows the last ${r.feedDays} days`);
        renderSettings();
      } catch (err) {
        toast(err.message, true);
      }
    };
  } catch (e) {
    el.innerHTML = `<div class="card empty"><h3>Couldn't load settings</h3><p>${esc(e.message)}</p></div>`;
  }
}

navigate(location.pathname, false);
