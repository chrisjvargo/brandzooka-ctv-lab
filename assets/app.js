"use strict";
/* Brandzooka Screening Room — static, no build step. GitHub Pages safe.
   One tile per creative (115); flights (148) nest inside detail view. */

const $ = (id) => document.getElementById(id);

const state = { rows: [], filtered: [], detailPos: 0, p75: {}, themes: new Set(), format: new Set(), aud: new Set(), daypart: false, goalTab: "CTR" };

const FORMAT_PARAMS = [
  { key: "web", label: "Web", match: (r) => r.flights.some((f) => f.targeting.placements.includes("web")) },
  { key: "mobile", label: "Mobile", match: (r) => r.flights.some((f) => f.targeting.placements.includes("mobile")) },
  { key: "apps", label: "Apps", match: (r) => r.flights.some((f) => f.targeting.placements.includes("apps")) },
];

/* Audience wall params are built dynamically from the data (gender, age
   ranges, countries, geo scope, top interests). OR within the wall, AND
   across filter groups. */
let AUD_PARAMS = [];

function audWallLabel(min, max) {
  if (min == null && max == null) return "Any age";
  if (min != null && max != null) return `Ages ${min}–${max}`;
  if (min != null) return `Ages ${min}+`;
  return `Up to ${max}`;
}

function buildAudParams(rows) {
  const has = (pred) => rows.filter((r) => r.flights.some((f) => pred(f.targeting))).length;
  const out = [];
  const nf = has((t) => t.gender === "female");
  const nm = has((t) => t.gender === "male");
  if (nf) out.push({ key: "g:female", label: "Women", n: nf, match: (r) => r.flights.some((f) => f.targeting.gender === "female") });
  if (nm) out.push({ key: "g:male", label: "Men", n: nm, match: (r) => r.flights.some((f) => f.targeting.gender === "male") });
  const ages = new Map();
  for (const r of rows) {
    const seen = new Set();
    for (const f of r.flights) {
      const k = `${f.targeting.ageMin ?? ""}|${f.targeting.ageMax ?? ""}`;
      if (!seen.has(k)) { seen.add(k); ages.set(k, (ages.get(k) || 0) + 1); }
    }
  }
  [...ages.entries()].filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, n]) => {
      const [mn, mx] = k.split("|").map((x) => (x === "" ? null : Number(x)));
      out.push({ key: `a:${k}`, label: audWallLabel(mn, mx), n, match: (r) => r.flights.some((f) => f.targeting.ageMin === mn && f.targeting.ageMax === mx) });
    });
  const countries = new Map();
  for (const r of rows) {
    const seen = new Set();
    for (const f of r.flights) for (const c of (f.targeting.countries || [])) seen.add(c);
    for (const c of seen) countries.set(c, (countries.get(c) || 0) + 1);
  }
  [...countries.entries()].filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .forEach(([c, n]) => {
      out.push({ key: `c:${c}`, label: c, n, match: (r) => r.flights.some((f) => (f.targeting.countries || []).includes(c)) });
    });
  const nReg = has((t) => t.regions > 0);
  const nZip = has((t) => t.zips > 0);
  if (nReg) out.push({ key: "geo:regions", label: "Region-targeted", n: nReg, match: (r) => r.flights.some((f) => f.targeting.regions > 0) });
  if (nZip) out.push({ key: "geo:zips", label: "ZIP-targeted", n: nZip, match: (r) => r.flights.some((f) => f.targeting.zips > 0) });
  const interests = new Map();
  for (const r of rows) {
    const seen = new Set();
    for (const f of r.flights) for (const i of f.targeting.interests) seen.add(i);
    for (const i of seen) interests.set(i, (interests.get(i) || 0) + 1);
  }
  [...interests.entries()].filter(([, n]) => n >= 6)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .forEach(([label, n]) => {
      out.push({ key: `i:${label}`, label, n, match: (r) => r.flights.some((f) => f.targeting.interests.includes(label)) });
    });
  return out;
}

const GOAL_TABS = [
  { key: "", label: "All goals", sort: null, match: () => true },
  { key: "CTR", label: "CTR", sort: "ctr-desc", match: (r) => r.goals.includes("CTR") },
  { key: "viewability", label: "Viewability", sort: "viewability-desc", match: (r) => r.goals.includes("viewability") },
  { key: "reach", label: "Reach", sort: "impressions-desc", match: (r) => r.goals.includes("reach") },
  { key: "__none", label: "Not set", sort: null, match: (r) => !r.goals.length },
];

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const fmtInt = (n) => n == null ? "—" : Number(n).toLocaleString("en-US");
const fmt1 = (n) => n == null ? "—" : Number(n).toFixed(1);
const fmtMoney = (n) => n == null ? "—" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
const fmtDur = (s) => {
  if (s == null) return "—";
  const m = Math.floor(s / 60), sec = Math.round(s % 60);
  return m + ":" + String(sec).padStart(2, "0");
};
const spotLabel = (s) => {
  if (s == null) return "runtime unknown";
  if (s <= 17) return ":15 or shorter";
  if (s <= 33) return ":20–:30 range";
  return "long-form, over :30";
};

let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function percentile(vals, p) {
  const v = vals.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.floor(p * v.length))];
}

/* ---------------- filtering + sorting ---------------- */
const SORTS = {
  "completion-desc": (a, b) => (b.metrics.completion ?? -1) - (a.metrics.completion ?? -1),
  "ctr-desc": (a, b) => (b.metrics.ctr ?? -1) - (a.metrics.ctr ?? -1),
  "viewability-desc": (a, b) => (b.metrics.viewability ?? -1) - (a.metrics.viewability ?? -1),
  "impressions-desc": (a, b) => b.metrics.impressions - a.metrics.impressions,
  "clicks-desc": (a, b) => b.metrics.clicks - a.metrics.clicks,
  "delivery-desc": (a, b) => (b.metrics.deliveryPct ?? -1) - (a.metrics.deliveryPct ?? -1),
  "spent-desc": (a, b) => (b.metrics.spent ?? -1) - (a.metrics.spent ?? -1),
  "duration-asc": (a, b) => (a.media.duration ?? 1e9) - (b.media.duration ?? 1e9),
  "duration-desc": (a, b) => (b.media.duration ?? -1) - (a.media.duration ?? -1),
  "title-asc": (a, b) => String(a.title).localeCompare(String(b.title)),
};

function ageLabel(t, cap) {
  if (t.ageMin == null && t.ageMax == null) return cap ? "Any age" : "any age";
  if (t.ageMin != null && t.ageMax != null) return `${cap ? "Ages " : ""}${t.ageMin}–${t.ageMax}`;
  if (t.ageMin != null) return `${cap ? "Ages " : ""}${t.ageMin}+`;
  return cap ? `Up to ${t.ageMax}` : `up to ${t.ageMax}`;
}

function flightTargetLine(t) {
  const g = t.gender ? t.gender[0].toUpperCase() + t.gender.slice(1) : "All";
  const pl = t.placements.length ? t.placements.join(" + ") : "no placement filter";
  return `${g} · ${ageLabel(t, false)} · ${pl}`;
}

function creativeTargetLine(r) {
  const lines = r.flights.map((f) => flightTargetLine(f.targeting));
  if (new Set(lines).size === 1) return lines[0];
  return `Mixed targeting across ${r.flights.length} flights`;
}

function applyFilters() {
  const q = $("search").value.trim().toLowerCase();
  const slice = $("sliceSel").value;
  const sortFn = SORTS[$("sortSel").value] || SORTS["completion-desc"];
  const tab = GOAL_TABS.find((t) => t.key === state.goalTab) || GOAL_TABS[0];
  state.filtered = state.rows.filter((r) => {
    if (slice && String(r.slice) !== slice) return false;
    if (!tab.match(r)) return false;
    if (state.themes.size && !state.themes.has(r.theme)) return false;
    if (state.format.size && !FORMAT_PARAMS.some((p) => state.format.has(p.key) && p.match(r))) return false;
    if (state.aud.size && !AUD_PARAMS.some((p) => state.aud.has(p.key) && p.match(r))) return false;
    if (state.daypart && !r.flights.some((f) => f.targeting.daypart)) return false;
    if (q) {
      const hay = `${r.row} ${r.title} ${r.videoId} ${r.advertisers.map((a) => a.short).join(" ")} ` +
        r.flights.map((f) => `${f.title} ${(f.landing || {}).domain || ""}`).join(" ");
      if (!hay.toLowerCase().includes(q)) return false;
    }
    return true;
  }).sort(sortFn);
  $("resultCount").textContent = `${state.filtered.length} of ${state.rows.length} creatives`;
  $("reelBtn").textContent = `▶ Play reel · ${state.filtered.length}`;
  renderGrid();
}

function resetFilters() {
  $("search").value = ""; $("sliceSel").value = "";
  state.themes.clear();
  document.querySelectorAll('#themeList input[type="checkbox"]').forEach((c) => { c.checked = false; });
  clearTags();
  setGoalTab("CTR");
}

function clearTags() {
  state.format.clear();
  state.aud.clear();
  state.daypart = false;
  document.querySelectorAll(".wall .chip").forEach((c) => c.setAttribute("aria-pressed", "false"));
  applyFilters();
}

function setGoalTab(key) {
  state.goalTab = key;
  document.querySelectorAll("#goalTabs .goaltab").forEach((b) => {
    b.setAttribute("aria-selected", b.dataset.tab === key ? "true" : "false");
  });
  const tab = GOAL_TABS.find((t) => t.key === key);
  if (tab && tab.sort) $("sortSel").value = tab.sort;
  applyFilters();
}

function buildGoalTabs() {
  $("goalTabs").innerHTML = GOAL_TABS.map((t) => {
    const n = state.rows.filter(t.match).length;
    return `<button class="goaltab" role="tab" data-tab="${esc(t.key)}" aria-selected="${t.key === state.goalTab}" type="button">${esc(t.label)}<span class="tab-n">${n}</span></button>`;
  }).join("");
  $("goalTabs").querySelectorAll(".goaltab").forEach((b) => {
    b.addEventListener("click", () => setGoalTab(b.dataset.tab));
  });
}

/* Flowing chip wall: wraps to fill the sidebar at any width. */
function buildWall(elId, params, set) {
  $(elId).innerHTML = params.map((p) =>
    `<button type="button" class="chip" data-key="${esc(p.key)}" aria-pressed="false">${esc(p.label)}<span class="chip-n">${p.n}</span></button>`
  ).join("");
  $(elId).querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const on = chip.getAttribute("aria-pressed") === "true";
      chip.setAttribute("aria-pressed", on ? "false" : "true");
      if (on) set.delete(chip.dataset.key);
      else set.add(chip.dataset.key);
      applyFilters();
    });
  });
}

function buildWalls() {
  buildWall("formatWall", FORMAT_PARAMS.map((p) => ({ ...p, n: state.rows.filter(p.match).length })), state.format);
  buildWall("audWall", AUD_PARAMS, state.aud);
  const nDay = state.rows.filter((r) => r.flights.some((f) => f.targeting.daypart)).length;
  const sched = $("schedWall");
  sched.innerHTML = `<button type="button" class="chip" id="daypartChip" aria-pressed="false">Dayparted<span class="chip-n">${nDay}</span></button>`;
  $("daypartChip").addEventListener("click", () => {
    state.daypart = !state.daypart;
    $("daypartChip").setAttribute("aria-pressed", state.daypart ? "true" : "false");
    applyFilters();
  });
}

/* ---------------- grid ---------------- */
function metricMini(name, val, max) {
  const pct = val == null ? 0 : Math.max(0, Math.min(100, (val / max) * 100));
  const hot = val != null && state.p75[name] != null && val >= state.p75[name] ? " hot" : "";
  return `<div class="metric-mini"><div class="mm-label"><span>${name}</span><b>${val == null ? "—" : fmt1(val)}</b></div>` +
    `<div class="mm-bar"><div class="mm-fill${hot}" style="width:${pct.toFixed(1)}%"></div></div></div>`;
}

function goalChip(r) {
  if (!r.goals.length) return `<span class="goal-chip goal-none">goal: not set</span>`;
  if (r.goals.length > 1) return `<span class="goal-chip goal-mixed" title="${esc(r.goals.join(", "))}">mixed goals</span>`;
  return `<span class="goal-chip goal-${esc(r.goals[0])}">goal: ${esc(r.goals[0])}</span>`;
}

function flightGoalChip(goal) {
  if (!goal) return `<span class="goal-chip goal-none">goal: not set</span>`;
  return `<span class="goal-chip goal-${esc(goal)}">goal: ${esc(goal)}</span>`;
}

function renderGrid() {
  const grid = $("grid");
  if (!state.filtered.length) {
    grid.innerHTML = `<div class="empty-note">No creatives match these filters. <button class="btn btn-ghost" id="clearFiltersEmpty" type="button">Clear filters</button></div>`;
    $("clearFiltersEmpty").addEventListener("click", resetFilters);
    return;
  }
  grid.innerHTML = state.filtered.map((r) => {
    const multi = r.flights.length > 1 ? `<span class="reuse-tick" title="This creative ran as ${r.flights.length} flights — compare them inside">×${r.flights.length} flights</span>` : "";
    const degen = r.flags.includes("has-degenerate-flight") ? `<span class="degen-tick" title="A flight of this creative barely delivered — discuss why">degenerate flight</span>` : "";
    const unwatch = r.flags.includes("unwatchable-source") ? `<span class="unwatch-tick" title="Source file is corrupt — verified, not your browser">unwatchable source</span>` : "";
    return `<article class="card" tabindex="0" data-row="${esc(r.row)}" aria-label="${esc(r.title)}">
      <div class="poster-wrap">
        <img src="${esc(r.media.poster)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=&quot;poster-fallback&quot;>poster coming with media pack</div>'">
        ${multi}${degen}${unwatch}
        <span class="dur-badge">${fmtDur(r.media.duration)}</span>
        <span class="play-hint">▶ screen it</span>
      </div>
      <div class="card-body">
        <div class="card-idrow"><span class="card-rowid">${esc(r.row)} · slice ${r.slice}</span>${goalChip(r)}</div>
        <h3 class="card-title">${esc(r.title)}</h3>
        <div class="card-theme">${esc(r.theme)}</div>
        ${metricMini("completion", r.metrics.completion, 100)}
        ${metricMini("ctr", r.metrics.ctr, 7)}
        ${metricMini("viewability", r.metrics.viewability, 100)}
        <div class="card-target" title="${esc(creativeTargetLine(r))}">${esc(creativeTargetLine(r))}</div>
      </div>
    </article>`;
  }).join("");
  grid.querySelectorAll(".card").forEach((card) => {
    card.addEventListener("click", () => openDetail(card.dataset.row));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(card.dataset.row); }
    });
  });
}

/* ---------------- detail view ---------------- */
function daypartHTML(dp) {
  if (!dp) return `<p class="daypart-note">No schedule restriction in the data — this flight has no daypart limits on record.</p>`;
  const on = new Set(dp.slots);
  let cells = `<div class="daypart"><span></span>`;
  for (let h = 0; h < 24; h++) {
    cells += `<span class="dp-hour">${h % 6 === 0 ? h : ""}</span>`;
  }
  for (let d = 0; d < 7; d++) {
    cells += `<span class="dp-day">Day ${d + 1}</span>`;
    for (let h = 0; h < 24; h++) {
      cells += `<span class="dp-cell${on.has(d * 24 + h) ? " on" : ""}"></span>`;
    }
  }
  cells += `</div><p class="daypart-note">${dp.slots.length} of 168 week-hours active (${(dp.coverage * 100).toFixed(0)}%). Days are numbered — the weekday mapping is unverified.</p>`;
  return cells;
}

function interestsHTML(t) {
  let html = "";
  if (t.interests.length) {
    html += `<ul class="interest-list">${t.interests.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
  } else {
    html += `<p class="daypart-note">No readable interest targeting on this flight.</p>`;
  }
  if (t.interestsHashed > 0) {
    html += `<span class="tchip hashed-note">+${t.interestsHashed} hashed interest code${t.interestsHashed > 1 ? "s" : ""} — targeting existed but can't be read</span>`;
  }
  return html;
}

function targetingChips(t) {
  const gender = t.gender ? t.gender[0].toUpperCase() + t.gender.slice(1) : "All genders";
  return `<span class="tchip">${esc(gender)}</span><span class="tchip">${esc(ageLabel(t, true))}</span>` +
    (t.placements.map((p) => `<span class="tchip">${esc(p)}</span>`).join("") || `<span class="tchip hashed-note">no placement filter</span>`) +
    (t.country ? `<span class="tchip">${esc(t.country)}</span>` : `<span class="tchip hashed-note">no country filter</span>`) +
    (t.regions > 0 ? `<span class="tchip hashed-note">${t.regions} hashed region code${t.regions > 1 ? "s" : ""} — geo-targeted, places unreadable</span>` : `<span class="tchip hashed-note">no region targeting</span>`);
}

function flightCardHTML(r, f) {
  const m = f.metrics;
  return `<div class="flight-card">
    <div class="flight-head"><span class="flight-n">Flight ${f.n} of ${r.flights.length}</span>${flightGoalChip(f.goal)}
      ${f.flags.includes("degenerate-flight") ? `<span class="tchip" style="border-color:var(--warn);color:var(--warn)">degenerate — barely delivered</span>` : ""}</div>
    <div class="flight-title">${esc(f.title)}</div>
    <table class="kv-table flight-kv"><tbody>
      <tr><td>Completion / CTR / Viewability</td><td>${fmt1(m.completion)} / ${fmt1(m.ctr)} / ${fmt1(m.viewability)}</td></tr>
      <tr><td>Impressions / Clicks</td><td>${fmtInt(m.impressions)} / ${fmtInt(m.clicks)}</td></tr>
      <tr><td>Delivery vs plan</td><td>${m.projected != null ? `${fmt1(m.deliveryPct)}%` : "no projection"}</td></tr>
      <tr><td>Spend</td><td>${fmtMoney(m.spent)} of ${fmtMoney(m.budget)}</td></tr>
      <tr><td>Win rate</td><td>${m.winRate != null ? fmt1(m.winRate) + "%" : "—"}</td></tr>
      <tr><td>Flight dates</td><td>${f.flight.from && f.flight.to ? `${esc(f.flight.from)} → ${esc(f.flight.to)} (${f.flight.days}d)` : "not on record"}</td></tr>
      <tr><td>Landing</td><td>${f.landing.domain ? `<a href="${esc(f.landing.url)}" target="_blank" rel="noopener">${esc(f.landing.domain)} ↗</a> <span title="2017 original link — may be dead">(2017)</span>` : "—"}</td></tr>
    </tbody></table>
    <div class="flight-target"><div class="flight-sub">Who it was bought for</div>${targetingChips(f.targeting)}${interestsHTML(f.targeting)}
      <div class="flight-sub">Schedule</div>${daypartHTML(f.targeting.daypart)}</div>
  </div>`;
}

function detailHTML(r) {
  const m = r.metrics, c = r.costs;
  const singleGoal = r.goals.length === 1 ? r.goals[0] : null;
  const goalHit = { viewability: "viewability", CTR: "ctr", reach: null }[singleGoal];
  const spendTotal = (c.targeting || 0) + (c.placement || 0) + (c.markup || 0);
  const adv = r.advertisers[0];
  const advSibs = state.rows.filter((x) => x.row !== r.row && x.advertisers.some((a) => a.id === adv.id)).map((x) => x.row);
  return `
    <h2 class="detail-title">${esc(r.title)}</h2>
    <div class="detail-sub"><span class="card-rowid">${esc(r.row)} · slice ${r.slice}</span>${goalChip(r)}
      <span class="tchip">${esc(r.theme)}</span>
      ${r.flights.length > 1 ? `<span class="tchip">${r.flights.length} flights — same creative</span>` : ""}
      ${r.flags.includes("has-degenerate-flight") ? `<span class="tchip" style="border-color:var(--warn);color:var(--warn)">has a degenerate flight</span>` : ""}
      ${r.flags.includes("unwatchable-source") ? `<span class="tchip" style="border-color:var(--signal);color:var(--signal)">unwatchable source</span>` : ""}
    </div>
    <div class="detail-cols">
      <div>
        ${r.flags.includes("unwatchable-source")
          ? `<div class="unwatch-note"><strong>This creative can't be screened.</strong> Its 2017 source file is corrupt (verified frame-by-frame — macroblock garbage throughout, not a browser issue). Code it from the metrics and targeting alone: note it as unwatchable and say what the numbers still tell you.</div>`
          : `<div class="video-shell"><video controls preload="metadata" poster="${esc(r.media.poster)}" src="${esc(r.media.mp4)}"></video></div>`}
        <div class="creative-facts">
          <span class="fact-chip">${fmtDur(r.media.duration)} · ${esc(spotLabel(r.media.duration))}</span>
          <span class="fact-chip">creative ${esc(r.videoId.slice(0, 12))}…</span>
          <span class="fact-chip">advertiser ${esc(adv.short)} · ${adv.campaigns} flight${adv.campaigns > 1 ? "s" : ""}</span>
        </div>
        <div class="panel" style="margin-top:14px"><h3>Numbers ${r.flights.length > 1 ? "(all flights combined)" : ""}</h3>
          <div class="big-metrics">
            <div class="big-metric"><div class="bm-val">${fmt1(m.completion)}<span class="bm-unit"> /100</span></div><div class="bm-name">Completion${r.flights.length > 1 ? " (weighted)" : ""}</div></div>
            <div class="big-metric${goalHit === "ctr" ? " goal-hit" : ""}"><div class="bm-val">${fmt1(m.ctr)}<span class="bm-unit"> /100</span></div><div class="bm-name">Click-through${singleGoal === "CTR" ? " ★ goal" : ""}</div></div>
            <div class="big-metric${goalHit === "viewability" ? " goal-hit" : ""}"><div class="bm-val">${fmt1(m.viewability)}<span class="bm-unit"> /100</span></div><div class="bm-name">Viewability${singleGoal === "viewability" ? " ★ goal" : ""}</div></div>
          </div>
          <table class="kv-table"><tbody>
            <tr><td>Impressions</td><td>${fmtInt(m.impressions)}${singleGoal === "reach" ? " ★ goal" : ""}</td></tr>
            <tr><td>Clicks</td><td>${fmtInt(m.clicks)}</td></tr>
            <tr><td>Delivery vs plan</td><td>${m.projected != null ? `${fmt1(m.deliveryPct)}%${m.deliveryFlights !== "1/1" ? ` (across ${m.deliveryFlights} flights)` : ""}` : "no projection on record"}</td></tr>
            <tr><td>Spend</td><td>${fmtMoney(m.spent)} of ${fmtMoney(m.budget)} budget</td></tr>
            <tr><td>Auction win rate</td><td>${m.winRate != null ? fmt1(m.winRate) + "%" + (r.flights.length > 1 ? " (weighted)" : "") : "—"}</td></tr>
            <tr><td>Flight range</td><td>${r.flightRange.from && r.flightRange.to ? `${esc(r.flightRange.from)} → ${esc(r.flightRange.to)}` : "dates not on record"}</td></tr>
          </tbody></table>
        </div>
        <div class="panel"><h3>Where the money went${r.flights.length > 1 ? " (summed)" : ""}</h3>
          <div class="spendbar">
            <span class="sp-target" style="width:${spendTotal ? ((c.targeting || 0) / spendTotal * 100).toFixed(1) : 0}%"></span>
            <span class="sp-place" style="width:${spendTotal ? ((c.placement || 0) / spendTotal * 100).toFixed(1) : 0}%"></span>
            <span class="sp-markup" style="width:${spendTotal ? ((c.markup || 0) / spendTotal * 100).toFixed(1) : 0}%"></span>
          </div>
          <div class="spend-legend">
            <span><i class="sp-target"></i>Targeting ${fmtMoney(c.targeting)}</span>
            <span><i class="sp-place"></i>Placement ${fmtMoney(c.placement)}</span>
            <span><i class="sp-markup"></i>Platform markup ${fmtMoney(c.markup)}</span>
          </div>
          <p class="daypart-note">Avg platform targeting share: ${c.targetingShare != null ? (c.targetingShare * 100).toFixed(0) + "%" : "—"}. Figures are platform records, not audited invoices.</p>
        </div>
        <div class="panel"><h3>Advertiser trail</h3>
          <p class="daypart-note" style="margin-top:0">Advertiser <span class="fact-chip">${esc(adv.short)}</span>${advSibs.length ? " also ran:" : " ran just this creative."}</p>
          ${advSibs.length ? `<div class="sib-row">${advSibs.map((s) => `<button class="sib-btn" data-sib="${esc(s)}" type="button">${esc(s)}</button>`).join("")}</div>` : ""}</div>
      </div>
      <div>
        <div class="panel"><h3>${r.flights.length > 1 ? `Flights ×${r.flights.length} — same creative, compare` : "The flight"}</h3>
          ${r.flights.map((f) => flightCardHTML(r, f)).join("")}
        </div>
        <p class="daypart-note">${esc(r.row)} · ${r.flights.map((f) => esc(f.campaignId)).join(" · ")}</p>
      </div>
    </div>`;
}

function openDetail(rowId) {
  const pos = state.filtered.findIndex((r) => r.row === rowId);
  state.detailPos = pos >= 0 ? pos : 0;
  renderDetail();
  $("detailOverlay").hidden = false;
  document.body.style.overflow = "hidden";
}

function renderDetail() {
  const r = state.filtered[state.detailPos];
  if (!r) return;
  $("detailId").textContent = `${r.row} · ${state.detailPos + 1} of ${state.filtered.length} in this view · slice ${r.slice}`;
  $("detailBody").innerHTML = detailHTML(r);
  $("detailBody").scrollTop = 0;
  $("prevBtn").disabled = state.detailPos <= 0;
  $("nextBtn").disabled = state.detailPos >= state.filtered.length - 1;
  const video = $("detailBody").querySelector("video");
  if (video) {
    video.addEventListener("error", () => {
      video.outerHTML = `<div class="poster-fallback" style="aspect-ratio:16/9">Video file not in this staging yet — the publish pack adds <br><span style="font-size:11px">${esc(r.media.mp4)}</span></div>`;
    }, true);
  }
  $("detailBody").querySelectorAll("[data-sib]").forEach((b) => {
    b.addEventListener("click", () => {
      const target = b.dataset.sib;
      const p = state.filtered.findIndex((x) => x.row === target);
      if (p >= 0) { state.detailPos = p; renderDetail(); }
      else toast(`${target} is outside the current filters`);
    });
  });
}

function closeDetail() {
  $("detailOverlay").hidden = true;
  document.body.style.overflow = "";
  $("detailBody").innerHTML = "";
}

/* ---------------- reel (YouTube-preroll mode) ---------------- */
const reel = { list: [], pos: 0, skipTimer: null, skipLeft: 0 };

function reelTimeStr(s) {
  if (!isFinite(s) || s == null) return "0:00";
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m + ":" + String(sec).padStart(2, "0");
}

function reelSetPlayIcon(playing) {
  $("reelPlayIcon").innerHTML = playing
    ? '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>'
    : '<path d="M8 5v14l11-7z"/>';
}

function reelArmSkip() {
  clearInterval(reel.skipTimer);
  const box = $("skipBox");
  box.hidden = false;
  box.classList.remove("ready");
  box.onclick = null;
  reel.skipLeft = 5;
  box.textContent = `Skip Ad in ${reel.skipLeft}`;
  reel.skipTimer = setInterval(() => {
    reel.skipLeft -= 1;
    if (reel.skipLeft <= 0) {
      clearInterval(reel.skipTimer);
      box.classList.add("ready");
      box.innerHTML = `<span class="skip-go">Skip Ad ▶</span>`;
      box.onclick = () => reelStep(1);
    } else {
      box.textContent = `Skip Ad in ${reel.skipLeft}`;
    }
  }, 1000);
}

function reelLoad(i) {
  const r = reel.list[i];
  if (!r) return;
  reel.pos = i;
  const v = $("reelVideo");
  v.poster = r.media.poster;
  v.src = r.media.mp4;
  $("reelTitle").textContent = `${r.row} — ${r.title}`;
  $("reelCount").textContent = `Video ${i + 1} of ${reel.list.length}`;
  $("reelScrub").value = 0;
  $("reelTime").textContent = "0:00 / " + fmtDur(r.media.duration);
  document.querySelectorAll("#reelQueue .reel-qitem").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.pos) === i);
  });
  const active = document.querySelector("#reelQueue .reel-qitem.active");
  if (active) active.scrollIntoView({ block: "nearest" });
  reelArmSkip();
  v.play().catch(() => {});
  reelSetPlayIcon(true);
}

function reelStep(d) {
  if (!reel.list.length) return;
  reelLoad((reel.pos + d + reel.list.length) % reel.list.length);
}

function reelJump(i) {
  if (!reel.list.length) return;
  reelLoad(Math.max(0, Math.min(reel.list.length - 1, i)));
}

function reelToggle() {
  const v = $("reelVideo");
  if (v.paused) { v.play().catch(() => {}); reelSetPlayIcon(true); }
  else { v.pause(); reelSetPlayIcon(false); }
}

function renderQueue() {
  $("reelQueue").innerHTML = reel.list.map((r, i) =>
    `<button class="reel-qitem${i === reel.pos ? " active" : ""}" data-pos="${i}" type="button">
      <img src="${esc(r.media.poster)}" alt="" loading="lazy">
      <span class="reel-qmeta"><span class="reel-qtitle">${esc(r.title)}</span>
      <span class="reel-qsub" style="display:block">${esc(r.row)} · ${fmtDur(r.media.duration)}</span></span>
    </button>`).join("");
  $("reelQueue").querySelectorAll(".reel-qitem").forEach((el) => {
    el.addEventListener("click", () => reelJump(Number(el.dataset.pos)));
  });
}

function openReel() {
  if (!state.filtered.length) { toast("No videos in this view"); return; }
  reel.list = [...state.filtered];
  $("reelOverlay").hidden = false;
  document.body.style.overflow = "hidden";
  renderQueue();
  reelLoad(0);
}

function closeReel() {
  clearInterval(reel.skipTimer);
  const v = $("reelVideo");
  v.pause();
  v.removeAttribute("src");
  v.load();
  $("reelOverlay").hidden = true;
  document.body.style.overflow = "";
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function wireReel() {
  const v = $("reelVideo");
  $("reelBtn").addEventListener("click", openReel);
  $("reelClose").addEventListener("click", closeReel);
  $("reelOverlay").addEventListener("click", (e) => { if (e.target === $("reelOverlay")) closeReel(); });
  $("reelNext").addEventListener("click", () => reelStep(1));
  $("reelPrev").addEventListener("click", () => reelStep(-1));
  $("reelPlay").addEventListener("click", reelToggle);
  v.addEventListener("click", reelToggle);
  v.addEventListener("ended", () => reelStep(1));
  v.addEventListener("play", () => reelSetPlayIcon(true));
  v.addEventListener("pause", () => reelSetPlayIcon(false));
  v.addEventListener("loadedmetadata", () => {
    $("reelTime").textContent = `0:00 / ${reelTimeStr(v.duration)}`;
  });
  v.addEventListener("timeupdate", () => {
    if (v.duration) $("reelScrub").value = Math.round(v.currentTime / v.duration * 1000);
    $("reelTime").textContent = `${reelTimeStr(v.currentTime)} / ${reelTimeStr(v.duration)}`;
  });
  $("reelScrub").addEventListener("input", () => {
    if (v.duration) v.currentTime = ($("reelScrub").value / 1000) * v.duration;
  });
  $("reelMute").addEventListener("click", () => {
    v.muted = !v.muted;
    $("reelMuteIcon").style.opacity = v.muted ? "0.4" : "1";
  });
  $("reelFull").addEventListener("click", () => {
    const stage = $("reelStage");
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (stage.requestFullscreen) stage.requestFullscreen().catch(() => {});
  });
}

/* ---------------- init ---------------- */
function buildThemeList() {
  const counts = new Map();
  for (const r of state.rows) counts.set(r.theme, (counts.get(r.theme) || 0) + 1);
  const themes = [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  $("themeList").innerHTML = themes.map(([t, c]) =>
    `<label class="theme-row"><input type="checkbox" value="${esc(t)}"><span>${esc(t)}</span><span>${c}</span></label>`).join("");
  $("themeList").querySelectorAll('input[type="checkbox"]').forEach((box) => {
    box.addEventListener("change", () => {
      if (box.checked) state.themes.add(box.value);
      else state.themes.delete(box.value);
      applyFilters();
    });
  });
}

async function init() {
  const missing = ["grid", "resultCount", "themeList", "goalTabs", "formatWall", "audWall", "schedWall"]
    .filter((id) => !$(id));
  if (missing.length) {
    const msg = `This copy of the page is stale &mdash; your browser mixed old and new files, so the videos can't load. <b>Hard-refresh once: &#8984;&#8679;R on Mac, Ctrl+Shift+R on Windows.</b>`;
    if ($("grid")) $("grid").innerHTML = `<div class="empty-note">${msg}</div>`;
    if ($("resultCount")) $("resultCount").textContent = "";
    return;
  }
  try {
    const res = await fetch("data/data.json");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    state.rows = data.rows;
  } catch (err) {
    $("grid").innerHTML = `<div class="empty-note">Couldn't load <b>data/data.json</b> (${esc(err.message)}).<br>Serve this folder over HTTP — e.g. <b>./serve.sh</b> — instead of opening the file directly.</div>`;
    $("resultCount").textContent = "";
    return;
  }
  for (const k of ["completion", "ctr", "viewability"]) {
    state.p75[k] = percentile(state.rows.map((r) => r.metrics[k]), 0.75);
  }
  buildThemeList();
  buildGoalTabs();
  AUD_PARAMS = buildAudParams(state.rows);
  buildWalls();
  $("sortSel").value = "ctr-desc";
  wireReel();
  applyFilters();

  $("clearFilters").addEventListener("click", resetFilters);
  $("search").addEventListener("input", applyFilters);
  for (const id of ["sortSel", "sliceSel"]) {
    $(id).addEventListener("change", applyFilters);
  }
  $("prevBtn").addEventListener("click", () => { if (state.detailPos > 0) { state.detailPos--; renderDetail(); } });
  $("nextBtn").addEventListener("click", () => { if (state.detailPos < state.filtered.length - 1) { state.detailPos++; renderDetail(); } });
  $("closeBtn").addEventListener("click", closeDetail);
  $("detailOverlay").addEventListener("click", (e) => { if (e.target === $("detailOverlay")) closeDetail(); });
  document.addEventListener("keydown", (e) => {
    if (!$("reelOverlay").hidden) {
      if (e.key === "Escape") closeReel();
      else if (e.key === "ArrowRight") reelStep(1);
      else if (e.key === "ArrowLeft") reelStep(-1);
      else if (e.key === " ") { e.preventDefault(); reelToggle(); }
      else if (e.key === "f") $("reelFull").click();
      else if (e.key === "m") $("reelMute").click();
    } else if (!$("detailOverlay").hidden) {
      if (e.key === "Escape") closeDetail();
      else if (e.key === "ArrowRight" && state.detailPos < state.filtered.length - 1) { state.detailPos++; renderDetail(); }
      else if (e.key === "ArrowLeft" && state.detailPos > 0) { state.detailPos--; renderDetail(); }
    }
  });
}

init().catch((err) => {
  const msg = `Something broke while starting (${esc(err && err.message)}). Try a hard refresh first (<b>&#8984;&#8679;R / Ctrl+Shift+R</b>) — if it persists, report this text.`;
  if ($("grid")) $("grid").innerHTML = `<div class="empty-note">${msg}</div>`;
});

