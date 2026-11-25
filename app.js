/* AgentBadge dApp — static, no backend, no keys.
 *
 * Reads go to public RPC endpoints (tried in order until one answers).
 * Writes go only through the injected wallet provider (window.ethereum):
 * the user confirms every transaction in their own wallet. Nothing is
 * ever sent automatically, and this page never asks for a password,
 * seed phrase, or any other credential.
 *
 * Design authority: frontend-design. Motion personality (motion-design):
 * Corporate — 200-400ms, ease-out entrances, no overshoot except a
 * small success pop. GSAP implements it; the page is fully readable
 * if GSAP or the wallet library fails to load.
 */
"use strict";

const CONTRACT_ADDRESS = "0xBe7754680b10Eac76bc7Bb88c71A900f7eD3d9B1";
const REGISTRY_ADDRESS = "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F";
const CHAIN_ID = 56;
const EXPLORER = "https://bscscan.com";

// Public read endpoints, neutral operators, tried in order.
const RPC_URLS = [
  "https://bsc-dataseed1.defibit.io/",
  "https://bsc-dataseed1.ninicoin.io/",
  "https://bsc-dataseed2.defibit.io/",
  "https://bsc-dataseed2.ninicoin.io/",
];

// Last block known to predate the deployment (mainnet fork block from the
// deploy verification notes, 2026-11-18). The contract did not exist here,
// so event scans starting at this block miss nothing.
const STATS_FROM_BLOCK = 134312552;

// Minimal ABI — only what the page uses.
const BADGE_ABI = [
  "function mint() returns (uint256)",
  "function checkin() returns (uint256)",
  "function burn(uint256 tokenId)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function badgeOf(address) view returns (uint256)",
  "function streak(uint256) view returns (uint256)",
  "function longestStreak(uint256) view returns (uint256)",
  "function lastCheckinDay(uint256) view returns (uint256)",
  "function mintedAt(uint256) view returns (uint256)",
  "function currentDay() view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
  "event Minted(address indexed holder, uint256 indexed tokenId)",
  "event CheckedIn(address indexed holder, uint256 indexed tokenId, uint256 streak, uint256 day)",
];
const REGISTRY_ABI = ["function balanceOf(address) view returns (uint256)"];

const $ = (id) => document.getElementById(id);
const reducedMotion =
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let browserProvider = null; // ethers BrowserProvider, once connected
let account = null; // checksummed address, once connected
let accountTokenId = 0n; // badge held by the connected account (0 = none)

/* ------------------------------------------------------------------ */
/* Read layer: try each RPC in turn until one answers.                 */
/* ------------------------------------------------------------------ */

function makeProviders() {
  return RPC_URLS.map(
    (url) => new ethers.JsonRpcProvider(url, CHAIN_ID, { staticNetwork: true })
  );
}

async function tryRead(fn) {
  let lastError;
  for (const provider of makeProviders()) {
    try {
      return await fn(provider);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("All read endpoints failed");
}

const badgeRead = (p) => new ethers.Contract(CONTRACT_ADDRESS, BADGE_ABI, p);
const registryRead = (p) =>
  new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, p);

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function shorten(addr) {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

function dateFromTimestamp(ts) {
  return new Date(Number(ts) * 1000).toISOString().slice(0, 10);
}

function dateFromDayNumber(day) {
  if (day === 0n) return "Never";
  return new Date(Number(day) * 86400000).toISOString().slice(0, 10);
}

function decodeTokenURI(uri) {
  // data:application/json;base64,<json> — the JSON carries a
  // data:image/svg+xml;base64,<svg> image. Both are produced on-chain.
  const jsonPart = uri.split(",", 2)[1];
  return JSON.parse(atob(jsonPart));
}

function explorerTx(hash) {
  return `${EXPLORER}/tx/${hash}`;
}

let toastTimer = null;
function showToast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 5000);
}

function pop(el) {
  if (window.gsap && !reducedMotion) {
    gsap.fromTo(
      el,
      { scale: 0.96 },
      { scale: 1, duration: 0.35, ease: "back.out(2)", clearProps: "scale" }
    );
  }
}

function friendlyError(err) {
  const msg = String((err && (err.reason || err.message)) || err);
  if (err && err.code === 4001) return "Transaction rejected in your wallet.";
  if (msg.includes("NotAgentIdHolder"))
    return "This address doesn't hold an Agent ID, so it can't mint a badge.";
  if (msg.includes("AlreadyMinted"))
    return "This address already holds a badge.";
  if (msg.includes("AlreadyCheckedInToday"))
    return "Already checked in today. Come back tomorrow (UTC).";
  if (msg.includes("NotBadgeHolder"))
    return "This address doesn't hold a badge.";
  if (msg.includes("NotTokenOwner"))
    return "Only the badge owner can burn it.";
  if (msg.includes("insufficient funds"))
    return "Not enough funds in your wallet to pay the network gas fee.";
  if (msg.includes("network") || msg.includes("fetch"))
    return "Network error talking to the chain. Check your connection and try again.";
  return "Something went wrong: " + msg.slice(0, 160);
}

/* ------------------------------------------------------------------ */
/* Live stats                                                          */
/*                                                                     */
/* Badges minted: counted two ways. The event-log scan is the direct   */
/* count, but public endpoints often refuse eth_getLogs, so the        */
/* primary count is a token-ID search: IDs are sequential from 1 and   */
/* never reused, so the highest existing ID is the number minted       */
/* (minus any burned badges — none so far). Check-ins can only be      */
/* counted from event logs; when logs are unavailable the stat is      */
/* shown as unavailable rather than guessed.                           */
/* ------------------------------------------------------------------ */

async function tokenExists(provider, id) {
  try {
    await badgeRead(provider).ownerOf(id);
    return true;
  } catch {
    return false; // nonexistent token reverts
  }
}

async function countBadgesBySearch() {
  return tryRead(async (provider) => {
    if (!(await tokenExists(provider, 1))) return 0;
    let lo = 1;
    let hi = 2;
    while (await tokenExists(provider, hi)) {
      lo = hi;
      hi *= 2;
      if (hi > 1000000) break;
    }
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (await tokenExists(provider, mid)) lo = mid;
      else hi = mid;
    }
    // Confirm nothing hides above the boundary (guards against a burn
    // gap confusing the search): probe ahead in windows of 8.
    for (let round = 0; round < 3; round++) {
      let found = lo;
      for (let i = 1; i <= 8; i++) {
        if (await tokenExists(provider, lo + i)) found = lo + i;
      }
      if (found === lo) break;
      lo = found;
    }
    return lo;
  });
}

async function scanEventCounts() {
  // Event topics are computed from the signatures at runtime, never
  // hardcoded. One scan with an OR filter counts both event types.
  const mintedTopic = ethers.id("Minted(address,uint256)");
  const checkedInTopic = ethers.id(
    "CheckedIn(address,uint256,uint256,uint256)"
  );
  const CHUNK = 10000;
  const CONCURRENCY = 6;

  return tryRead(async (provider) => {
    const latest = await provider.getBlockNumber();
    const ranges = [];
    for (let from = STATS_FROM_BLOCK; from <= latest; from += CHUNK) {
      ranges.push([from, Math.min(from + CHUNK - 1, latest)]);
    }
    let minted = 0;
    let checkins = 0;
    for (let i = 0; i < ranges.length; i += CONCURRENCY) {
      const batch = ranges.slice(i, i + CONCURRENCY).map(([from, to]) =>
        provider.getLogs({
          address: CONTRACT_ADDRESS,
          topics: [[mintedTopic, checkedInTopic]],
          fromBlock: from,
          toBlock: to,
        })
      );
      const results = await Promise.all(batch);
      for (const logs of results) {
        for (const log of logs) {
          if (log.topics[0] === mintedTopic) minted++;
          else if (log.topics[0] === checkedInTopic) checkins++;
        }
      }
    }
    return { minted, checkins };
  });
}

async function loadStats() {
  const mintedEl = $("statMinted");
  const checkinsEl = $("statCheckins");
  const latestEl = $("statLatest");
  const noteEl = $("statsNote");

  const searchP = countBadgesBySearch();
  const scanP = scanEventCounts();

  const maxId = await searchP.catch(() => null);
  if (maxId === null) {
    mintedEl.textContent = "—";
    latestEl.textContent = "—";
  } else {
    latestEl.textContent = maxId === 0 ? "—" : "#" + maxId;
    mintedEl.textContent = String(maxId);
  }

  const scan = await scanP.catch(() => null);
  if (scan) {
    // The log count is the authoritative "ever minted" number (it
    // includes badges later burned); prefer it when available.
    mintedEl.textContent = String(scan.minted);
    checkinsEl.textContent = String(scan.checkins);
  } else {
    checkinsEl.textContent = "—";
    noteEl.textContent =
      "Check-in total unavailable: the public endpoints this page uses are not returning event logs right now. Badge counts come from direct chain reads instead.";
    noteEl.hidden = false;
  }
}

/* ------------------------------------------------------------------ */
/* Hero badge: the real Badge #1 artwork, loaded from the chain.       */
/* ------------------------------------------------------------------ */

async function loadHeroBadge() {
  try {
    const uri = await tryRead((p) => badgeRead(p).tokenURI(1));
    const meta = decodeTokenURI(uri);
    const minted = (meta.attributes || []).find((a) => a.trait_type === "Minted");
    const streak = (meta.attributes || []).find((a) => a.trait_type === "Streak");
    const img = $("heroBadgeImg");
    img.src = meta.image;
    img.alt = meta.name;
    // NOTE: setAttribute, not the .hidden property — SVG elements have no
    // `hidden` IDL attribute, so `.hidden = true` on the preview <svg>
    // would silently do nothing (it only sets a JS expando).
    img.removeAttribute("hidden");
    $("heroPreview").setAttribute("hidden", "");
    $("heroCaption").textContent =
      `${meta.name} · minted ${minted ? minted.value : "—"} · streak ${streak ? streak.value : 0} days. The artwork lives entirely on-chain.`;
  } catch {
    // Keep the preview art; the caption already says it is a preview.
  }
}

/* ------------------------------------------------------------------ */
/* Wallet connection (injected provider only)                          */
/* ------------------------------------------------------------------ */

function showState(id) {
  for (const s of ["accountEmpty", "accountWrongChain", "accountReady"]) {
    $(s).hidden = s !== id;
  }
}

function setAccountStatus(html, kind) {
  const el = $("accountStatus");
  el.innerHTML = html;
  el.className = "tx-status" + (kind ? " " + kind : "");
  el.hidden = false;
}

function clearAccountStatus() {
  $("accountStatus").hidden = true;
}

async function connect() {
  if (!window.ethereum) {
    showToast(
      "No wallet found in this browser. Install a browser wallet extension that provides an injected provider, then reload the page."
    );
    return;
  }
  try {
    browserProvider = new ethers.BrowserProvider(window.ethereum);
    const accounts = await browserProvider.send("eth_requestAccounts", []);
    if (!accounts.length) return;
    account = ethers.getAddress(accounts[0]);
    const network = await browserProvider.getNetwork();
    if (network.chainId !== BigInt(CHAIN_ID)) {
      showState("accountWrongChain");
      return;
    }
    await refreshAccount();
  } catch (err) {
    if (err && err.code === 4001) {
      showToast("Connection rejected in your wallet.");
    } else {
      showToast(friendlyError(err));
    }
  }
}

async function switchChain() {
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x" + CHAIN_ID.toString(16) }],
    });
  } catch (err) {
    if (err && err.code === 4902) {
      showToast(
        "Chain 56 is not in your wallet yet. Add it in your wallet settings, then try again."
      );
    } else if (err && err.code === 4001) {
      showToast("Network switch rejected in your wallet.");
    } else {
      showToast(friendlyError(err));
    }
  }
}

async function refreshAccount() {
  if (!account) return;
  showState("accountReady");
  $("accountAddr").textContent = account;
  $("agentIdStatus").textContent = "Checking…";
  $("agentIdStatus").className = "status-line";
  $("noBadge").hidden = true;
  $("hasBadge").hidden = true;
  $("burnConfirm").hidden = true;
  clearAccountStatus();

  try {
    const agentBal = await tryRead((p) => registryRead(p).balanceOf(account));
    const badgeId = await tryRead((p) => badgeRead(p).badgeOf(account));
    accountTokenId = badgeId;

    if (agentBal > 0n) {
      $("agentIdStatus").textContent = "✓ This address holds an Agent ID.";
      $("agentIdStatus").className = "status-line ok";
    } else {
      $("agentIdStatus").textContent =
        "This address doesn't hold an Agent ID, so it can't mint a badge.";
      $("agentIdStatus").className = "status-line warn";
    }

    if (badgeId === 0n) {
      $("mintPitch").textContent =
        agentBal > 0n
          ? "You hold an Agent ID. Your badge is free — you only pay the network gas fee."
          : "Minting needs an Agent ID. This address doesn't hold one yet.";
      $("mintBtn").disabled = agentBal === 0n;
      $("noBadge").hidden = false;
      return;
    }

    // Badge held: load its details + artwork.
    const [streak, longest, lastDay, mintedAt, today, uri] = await Promise.all([
      tryRead((p) => badgeRead(p).streak(badgeId)),
      tryRead((p) => badgeRead(p).longestStreak(badgeId)),
      tryRead((p) => badgeRead(p).lastCheckinDay(badgeId)),
      tryRead((p) => badgeRead(p).mintedAt(badgeId)),
      tryRead((p) => badgeRead(p).currentDay()),
      tryRead((p) => badgeRead(p).tokenURI(badgeId)),
    ]);
    const meta = decodeTokenURI(uri);
    $("badgeImg").src = meta.image;
    $("badgeImg").alt = meta.name;
    $("badgeTitle").textContent = meta.name;
    $("factStreak").textContent = streak + (streak === 1n ? " day" : " days");
    $("factLongest").textContent =
      longest + (longest === 1n ? " day" : " days");
    $("factMinted").textContent = dateFromTimestamp(mintedAt);
    $("factLast").textContent = dateFromDayNumber(lastDay);

    const checkedInToday = lastDay !== 0n && lastDay === today;
    const btn = $("checkinBtn");
    btn.disabled = checkedInToday;
    btn.textContent = checkedInToday
      ? "Checked in today — come back tomorrow"
      : "Check in today";
    $("burnTokenLabel").textContent = meta.name;
    $("hasBadge").hidden = false;
  } catch (err) {
    $("agentIdStatus").textContent =
      "Couldn't read the chain right now. Check your connection and reload.";
    $("agentIdStatus").className = "status-line warn";
  }
}

/* ------------------------------------------------------------------ */
/* Writes: mint / check-in / burn. Every call opens a wallet prompt;   */
/* nothing is sent until the user confirms it there.                   */
/* ------------------------------------------------------------------ */

async function sendWrite(label, fn) {
  const signer = await browserProvider.getSigner();
  const contract = new ethers.Contract(CONTRACT_ADDRESS, BADGE_ABI, signer);
  setAccountStatus(`Waiting for your wallet to confirm ${label}…`);
  let tx;
  try {
    tx = await fn(contract);
  } catch (err) {
    setAccountStatus(friendlyError(err), "error");
    throw err;
  }
  setAccountStatus(
    `${label} sent — <a href="${explorerTx(tx.hash)}" target="_blank" rel="noopener">view transaction</a>. Waiting for confirmation…`
  );
  const receipt = await tx.wait();
  if (receipt.status !== 1) {
    setAccountStatus(
      `${label} failed on-chain. <a href="${explorerTx(tx.hash)}" target="_blank" rel="noopener">View transaction</a>`,
      "error"
    );
    throw new Error("Transaction reverted on-chain");
  }
  return receipt;
}

async function mint() {
  const btn = $("mintBtn");
  btn.disabled = true;
  try {
    await sendWrite("Mint", (c) => c.mint());
    setAccountStatus("Badge minted. Welcome.", "success");
    pop($("hasBadge"));
    await refreshAccount();
    loadStats();
  } catch {
    // Error already shown by sendWrite.
  } finally {
    btn.disabled = false;
  }
}

async function checkin() {
  const btn = $("checkinBtn");
  btn.disabled = true;
  try {
    await sendWrite("Check-in", (c) => c.checkin());
    setAccountStatus("Checked in. Streak updated.", "success");
    pop($("badgeImg"));
    await refreshAccount();
    loadStats();
  } catch {
    btn.disabled = false;
  }
}

async function burn() {
  const btn = $("burnConfirmBtn");
  btn.disabled = true;
  try {
    await sendWrite("Burn", (c) => c.burn(accountTokenId));
    setAccountStatus("Badge burned. You can mint a fresh one any time.", "success");
    $("burnConfirm").hidden = true;
    await refreshAccount();
    loadStats();
  } catch {
    // Error already shown by sendWrite.
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Read-only lookup                                                    */
/* ------------------------------------------------------------------ */

async function lookup(address) {
  const resultEl = $("lookupResult");
  const emptyEl = $("lookupEmpty");
  resultEl.hidden = true;
  emptyEl.hidden = false;
  emptyEl.textContent = "Looking up…";
  emptyEl.className = "status-line";

  if (!ethers.isAddress(address)) {
    emptyEl.textContent = "That doesn't look like an address. Paste a full 0x address.";
    return;
  }
  const addr = ethers.getAddress(address);
  try {
    const badgeId = await tryRead((p) => badgeRead(p).badgeOf(addr));
    if (badgeId === 0n) {
      emptyEl.textContent = `No badge for ${shorten(addr)}.`;
      return;
    }
    const [streak, longest, lastDay, mintedAt, uri] = await Promise.all([
      tryRead((p) => badgeRead(p).streak(badgeId)),
      tryRead((p) => badgeRead(p).longestStreak(badgeId)),
      tryRead((p) => badgeRead(p).lastCheckinDay(badgeId)),
      tryRead((p) => badgeRead(p).mintedAt(badgeId)),
      tryRead((p) => badgeRead(p).tokenURI(badgeId)),
    ]);
    const meta = decodeTokenURI(uri);
    $("lookupImg").src = meta.image;
    $("lookupImg").alt = meta.name;
    $("lookupTitle").textContent = `${meta.name} · ${shorten(addr)}`;
    $("lookupStreak").textContent = streak + (streak === 1n ? " day" : " days");
    $("lookupLongest").textContent =
      longest + (longest === 1n ? " day" : " days");
    $("lookupMinted").textContent = dateFromTimestamp(mintedAt);
    $("lookupLast").textContent = dateFromDayNumber(lastDay);
    emptyEl.hidden = true;
    resultEl.hidden = false;
    pop($("lookupImg"));
  } catch {
    emptyEl.textContent =
      "Couldn't read the chain right now. Check your connection and try again.";
  }
}

/* ------------------------------------------------------------------ */
/* Intro animation — one orchestrated sequence, skipped without GSAP    */
/* or when the user prefers reduced motion. Content is visible by      */
/* default; gsap.from() only animates from hidden, so a CDN failure   */
/* leaves a readable page.                                             */
/* ------------------------------------------------------------------ */

function introAnimation() {
  if (!window.gsap || reducedMotion) return;
  const tl = gsap.timeline({ defaults: { ease: "power2.out" } });
  tl.from(".hero-badge", { scale: 0.92, opacity: 0, duration: 0.6 })
    .from(".hero-title", { y: 24, opacity: 0, duration: 0.5 }, "-=0.35")
    .from(".hero-sub", { y: 16, opacity: 0, duration: 0.45 }, "-=0.3")
    .from(
      ".stat",
      { y: 12, opacity: 0, duration: 0.4, stagger: 0.07 },
      "-=0.25"
    )
    .from(
      ".panel",
      { y: 16, opacity: 0, duration: 0.45, stagger: 0.08 },
      "-=0.2"
    );
}

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */

function init() {
  if (!window.ethers) {
    $("statMinted").textContent = "—";
    $("statCheckins").textContent = "—";
    $("statLatest").textContent = "—";
    const note = $("statsNote");
    note.textContent =
      "The wallet library didn't load. Check your connection and reload the page.";
    note.hidden = false;
    return;
  }

  $("connectBtn").addEventListener("click", connect);
  document
    .querySelectorAll("[data-connect]")
    .forEach((b) => b.addEventListener("click", connect));
  $("switchChainBtn").addEventListener("click", switchChain);
  $("mintBtn").addEventListener("click", mint);
  $("checkinBtn").addEventListener("click", checkin);
  $("burnBtn").addEventListener("click", () => {
    $("burnConfirm").hidden = false;
  });
  $("burnCancelBtn").addEventListener("click", () => {
    $("burnConfirm").hidden = true;
  });
  $("burnConfirmBtn").addEventListener("click", burn);
  $("lookupForm").addEventListener("submit", (e) => {
    e.preventDefault();
    lookup($("lookupInput").value.trim());
  });

  if (window.ethereum) {
    window.ethereum.on("accountsChanged", (accounts) => {
      if (!accounts.length) {
        account = null;
        showState("accountEmpty");
      } else {
        account = ethers.getAddress(accounts[0]);
        refreshAccount();
      }
    });
    window.ethereum.on("chainChanged", () => window.location.reload());
  }

  loadStats();
  loadHeroBadge();
  introAnimation();
}

document.addEventListener("DOMContentLoaded", init);
