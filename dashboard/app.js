const PAGE_SIZE = 100;
const state = { launches: [], filtered: [], quotes: {}, page: 0 };
const $ = (selector) => document.querySelector(selector);
const shortAddress = (value) => `${value.slice(0, 6)}…${value.slice(-4)}`;
const number = new Intl.NumberFormat("en-US");
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 });
const h = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);

function renderMetrics(payload) {
  const launches = payload.launches;
  $("#totalLaunches").textContent = number.format(launches.length);
  $("#numeraireCount").textContent = number.format(new Set(launches.map((x) => x.numeraireSymbol)).size);
  $("#venueCount").textContent = number.format(new Set(launches.map((x) => x.venueKey)).size);
  $("#indexedBlock").textContent = number.format(payload.meta.indexedThroughBlock ?? 0);
  const generated = new Date(payload.meta.generatedAt);
  $("#freshness").textContent = `INDEX UPDATED ${generated.toLocaleString()} · ${payload.meta.source}`;
}

function populateFilters(launches) {
  const symbols = [...new Set(launches.map((x) => x.numeraireSymbol))].sort();
  $("#numeraireFilter").insertAdjacentHTML(
    "beforeend",
    symbols.map((symbol) => `<option value="${symbol}">${symbol}</option>`).join(""),
  );
}

function applyFilters() {
  const query = $("#search").value.trim().toLowerCase();
  const numeraire = $("#numeraireFilter").value;
  const sort = $("#sort").value;
  state.filtered = state.launches.filter((launch) => {
    const haystack = [launch.name, launch.symbol, launch.tokenAddress, launch.creator].join(" ").toLowerCase();
    return (!query || haystack.includes(query)) && (!numeraire || launch.numeraireSymbol === numeraire);
  });
  state.filtered.sort((a, b) => {
    if (sort === "oldest") return a.blockNumber - b.blockNumber;
    if (sort === "token") return a.symbol.localeCompare(b.symbol);
    return b.blockNumber - a.blockNumber;
  });
  state.page = 0;
  renderRows();
}

function renderRows() {
  const pageCount = Math.max(1, Math.ceil(state.filtered.length / PAGE_SIZE));
  state.page = Math.min(state.page, pageCount - 1);
  const start = state.page * PAGE_SIZE;
  const pageRows = state.filtered.slice(start, start + PAGE_SIZE);
  $("#launchRows").innerHTML = pageRows.map((launch, index) => {
    const quote = state.quotes[launch.numeraireAddress.toLowerCase()];
    const mid = quote?.adjustedMidUsd ?? launch.numeraireMidUsd;
    return `
    <tr data-index="${start + index}" tabindex="0">
      <td><div class="token-cell"><span class="token-icon">${h(launch.symbol.slice(0, 1))}</span><span class="token-copy"><strong>$${h(launch.symbol)}</strong><small>${h(launch.name)}</small></span></div></td>
      <td><strong>${h(launch.numeraireSymbol)}</strong><br><span class="venue">${h(shortAddress(launch.numeraireAddress))}</span></td>
      <td class="quote">${mid ? usd.format(Number(mid)) : "Unavailable"}</td>
      <td class="venue"><b>${h(launch.venueKey)}</b>chain ${h(launch.chainId)}</td>
      <td class="block">${number.format(launch.blockNumber)}</td>
      <td class="row-arrow">↗</td>
    </tr>`;
  }).join("");
  $("#emptyState").hidden = state.filtered.length !== 0;
  const visibleEnd = Math.min(start + PAGE_SIZE, state.filtered.length);
  $("#resultCount").textContent = state.filtered.length
    ? `${number.format(start + 1)}–${number.format(visibleEnd)} of ${number.format(state.filtered.length)} matches · ${number.format(state.launches.length)} total`
    : `0 matches · ${number.format(state.launches.length)} total`;
  $("#pageIndicator").textContent = `Page ${number.format(state.page + 1)} / ${number.format(pageCount)}`;
  $("#previousPage").disabled = state.page === 0;
  $("#nextPage").disabled = state.page >= pageCount - 1;
  $("#launchRows").querySelectorAll("tr").forEach((row) => {
    const open = () => showDetails(state.filtered[Number(row.dataset.index)]);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
    });
  });
}

function detail(label, value) {
  return `<div><span>${h(label)}</span><strong title="${h(value ?? "—")}">${h(value ?? "—")}</strong></div>`;
}

function showDetails(launch) {
  const quote = state.quotes[launch.numeraireAddress.toLowerCase()];
  const bid = quote?.adjustedBidUsd ?? launch.numeraireBidUsd;
  const ask = quote?.adjustedAskUsd ?? launch.numeraireAskUsd;
  const multiplier = quote?.currentMultiplier ?? launch.numeraireMultiplier;
  $("#dialogContent").innerHTML = `<div class="dialog-body">
    <div class="eyebrow">VERIFIED LAUNCH</div><h2>$${h(launch.symbol)}</h2><p>${h(launch.name)}</p>
    <div class="detail-grid">
      ${detail("Venue", launch.venueKey)}${detail("Chain ID", launch.chainId)}
      ${detail("Token", launch.tokenAddress)}${detail("Creator", launch.creator)}
      ${detail("Numeraire", `${launch.numeraireSymbol} · ${launch.numeraireAddress}`)}${detail("Multiplier", multiplier)}
      ${detail("Live USD bid / ask", `${bid ?? "—"} / ${ask ?? "—"}`)}${detail("Pool / hook", launch.poolAddress)}
      ${detail("Block", number.format(launch.blockNumber))}${detail("Timestamp", new Date(launch.timestamp).toLocaleString())}
      ${detail("Transaction", launch.transactionHash)}${detail("Source", launch.source)}
    </div>
    <a class="explorer-button" target="_blank" rel="noreferrer" href="https://robinhoodchain.blockscout.com/tx/${launch.transactionHash}">Open transaction ↗</a>
  </div>`;
  $("#detailDialog").showModal();
}

async function boot() {
  try {
    const response = await fetch("./data/launches.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`Data request failed: ${response.status}`);
    const payload = await response.json();
    state.quotes = payload.quotes ?? {};
    state.launches = payload.launches;
    renderMetrics(payload); populateFilters(payload.launches); applyFilters();
  } catch (error) {
    $("#freshness").textContent = `DATA UNAVAILABLE · ${error.message}`;
    $("#emptyState").hidden = false;
    $("#emptyState").textContent = "The launch dataset could not be loaded.";
  }
}

[$("#search"), $("#numeraireFilter"), $("#sort")].forEach((element) => element.addEventListener("input", applyFilters));
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && document.activeElement.tagName !== "INPUT") { event.preventDefault(); $("#search").focus(); }
});
$("#closeDialog").addEventListener("click", () => $("#detailDialog").close());
$("#detailDialog").addEventListener("click", (event) => { if (event.target === $("#detailDialog")) $("#detailDialog").close(); });
$("#previousPage").addEventListener("click", () => { state.page -= 1; renderRows(); $("#ledgerTitle").scrollIntoView(); });
$("#nextPage").addEventListener("click", () => { state.page += 1; renderRows(); $("#ledgerTitle").scrollIntoView(); });
boot();
