# AgentBadge frontend

A static single-page dApp for the AgentBadge contract
(`0xBe7754680b10Eac76bc7Bb88c71A900f7eD3d9B1`, chain 56). No build step,
no backend, no keys, no secrets.

## Files

- `index.html` — page structure and copy.
- `styles.css` — all styling. Palette matches the on-chain badge art:
  ink `#0b1020`, gold `#f5c542`, green `#7ee787`, muted `#9aa4b2`.
- `app.js` — all logic. ethers v6 (pinned CDN `6.13.5`) for chain reads
  and wallet writes; GSAP (pinned CDN `3.15.1`) for one entrance sequence
  and micro-interactions. The page is fully readable if either CDN fails.

## Serve locally

```sh
cd frontend
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy

Any static host works. For GitHub Pages: publish this directory (repo
Settings → Pages → deploy from the `frontend/` folder, or copy it to a
`docs/` folder / a `gh-pages` branch). No build, no environment
variables, no secrets to configure.

## Features

1. **Connect** — injected provider only (`window.ethereum`). No QR login,
   no web login, no credential fields anywhere.
2. **Agent ID status** — reads the registry `balanceOf` for the connected
   address and says plainly whether it can mint.
3. **Mint** — free (gas only). Opens a transaction in the user's own
   wallet; nothing is sent until they confirm it there. After mining, the
   transaction hash is shown with a BscScan link.
4. **Badge display** — renders the on-chain SVG from `tokenURI`, plus
   streak, longest streak, minted date, last check-in.
5. **Daily check-in** — disabled with a clear state when already checked
   in today (compared against the contract's on-chain `currentDay`).
6. **Burn** — two-step inline confirm, then the wallet prompt.
7. **Read-only lookup** — enter any address to see its badge/streak
   without connecting a wallet.
8. **Live stats** — badges minted + check-ins + latest badge.
9. **Honest copy** — free, soulbound, no rewards, no promised returns.
   Community project; no wallet/exchange/chain branding anywhere.

## How the stats work

- **Badges minted / latest badge:** token IDs are sequential from 1 and
  never reused, so the highest existing ID is found by an exponential +
  binary search over `ownerOf` (pure `eth_call`s, ~20 calls, with a
  confirm probe above the boundary in case a burn ever leaves a gap).
  When event logs are available, the `Minted` log count is preferred as
  the "ever minted" number (it includes badges later burned).
- **Check-ins:** counted from `CheckedIn` event logs (`eth_getLogs`,
  chunked, both event types in one scan via an OR topic filter). Event
  topics are computed from the signatures at runtime with `ethers.id()`.
- **Known limitation (verified 2026-11-24):** every tested public BSC
  RPC refuses `eth_getLogs` with `-32005 limit exceeded` — even for a
  single block — and alternative endpoints time out. The page therefore
  degrades gracefully: the check-in stat shows "—" with an honest note,
  while badge counts still come from direct chain reads. If a visitor's
  network allows `eth_getLogs`, the check-in count appears normally.

## Design

Design authority: `frontend-design` (distinctive identity, typography-led,
restraint — the badge art is the one memorable element). Motion follows
`motion-design`'s Corporate personality (200–400 ms, ease-out entrances,
no overshoot except a small success pop), implemented with GSAP.
`prefers-reduced-motion` is respected, and content is visible by default
(`gsap.from()`), so a GSAP CDN failure leaves a readable page.

## Verified state (2026-11-24, read directly from the chain)

- `currentDay()` = 20781 (matches 2026-11-24 UTC).
- `agentIdRegistry()` = `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F`.
- `name()` = "AgentBadge", `symbol()` = "AGBADGE".
- **49 badges minted** (IDs 1–49 all exist, none above 49, no gaps).
  Badge #1 is owned by `0xb92f509a35cbfbe95fa95f44455bdc79fc969a6b`
  (minted 2026-11-18, never checked in); badge #2 by
  `0xda2978745d7d89fdcdc0f1ecc217e8a67f84616b`. Neither is Kinder's
  wallet — the next mint takes the next sequential ID.
- Kinder's wallet (`0x2637…`) holds 1 Agent ID and no badge yet, so it
  is eligible to mint.
- Badges 1–12 have all never checked in (streak 0).
- `tokenURI(1)` decodes end-to-end: valid JSON, correct attributes,
  well-formed 653-byte SVG rendering the badge design.

## Screenshots

`shots/` holds Playwright renders (desktop 1280×800 + mobile 390×844):
no-wallet state, read-only lookup of a badge holder, lookup of an
address without a badge, and the connected badge-holder panel
(`desktop-connected-badge.png`, rendered with a mock injected provider —
no real wallet was connected).
