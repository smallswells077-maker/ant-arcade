# 🐜 Ant Arcade

A free, no-ads browser arcade with **13 games** and a **built-in web proxy** —
including a one-click **DuckDuckGo search** that runs through the proxy.

No build step. No framework. No database. Just static files plus one small
Cloudflare Function.

```
Public search box  →  proxy  →  html.duckduckgo.com
Game card          →  iframe  (or "Proxy on" to tunnel it)
Panic key (~)      →  straight to your boring page
```

---

## What's in the box

| Feature | Notes |
| --- | --- |
| 13 games | 3 written for this project + 10 open-source favourites |
| Web proxy | `/p?u=<base64url>` — rewrites HTML, CSS, links, redirects and JS requests |
| DuckDuckGo search | Homepage box, address bar and a 5-engine picker; POST search forms are converted to GET |
| Toggle proxy per game | Handy when a game's CDN is filtered but the proxy isn't |
| Favorites + recents | Stored in `localStorage` |
| Panic + cloak | `~` (or `Ctrl+Shift+X`) bails out; Settings renames the tab and icon |
| Fullscreen player | With reload, new-tab and proxy toggles |
| Mobile friendly | Touch controls in the three "Neon" games |

### Games included

Self-hosted (always work): **Neon Drift**, **Neon Snake**, **Neon Breakout**,
**Hextris**, **Tetris**, **Pong**, **Radius Raid**.

Embedded from GitHub Pages: **2048**, **Clumsy Bird**, **Astray**,
**Floppy Bird**, **Tower Game**, **Tic Tac Toe**.

Credits and licenses: [`public/games/CREDITS.md`](public/games/CREDITS.md).

---

## Project layout

```
ant-arcade/
├─ public/                     ← the static site (this is what you upload)
│  ├─ index.html
│  ├─ manifest.webmanifest
│  ├─ _headers                 (Cloudflare Pages / Netlify headers)
│  ├─ .nojekyll                (GitHub Pages: serve files as-is)
│  ├─ assets/
│  │  ├─ config.js             ← proxy URL, search engine, panic URL
│  │  ├─ proxy-config.js       ← deploy hook (optional PROXY_BASE)
│  │  ├─ games.js              ← game catalog (add your own here)
│  │  ├─ app.js
│  │  └─ style.css
│  └─ games/                   ← self-hosted games
├─ .github/workflows/
│  ├─ pages.yml                ← publish public/ to GitHub Pages
│  └─ deploy-worker.yml        ← optional: deploy the Worker via Cloudflare
├─ docs/DEPLOY-GITHUB-PAGES.md ← step-by-step GitHub Pages guide
├─ functions/
│  ├─ p.js                     ← Cloudflare Pages Function route: /p
│  └─ _lib/proxy.js            ← the proxy itself (shared source of truth)
├─ proxy/
│  └─ worker.standalone.js     ← generated single-file Worker (paste & deploy)
├─ worker.js                   ← Worker entry for `wrangler deploy`
├─ wrangler.toml
├─ start.bat                    ← double-click local preview (Windows)
└─ tools/
   ├─ bundle_proxy.py           ← rebuilds worker.standalone.js
   └─ dev_server.py             ← local static server + working /p proxy
```

---

## Quick local preview

The site ships with a small Python server that serves `public/` **and**
implements the proxy, so search and browsing work locally with no Node,
Cloudflare account or deployment:

```powershell
py tools/dev_server.py
# -> http://localhost:8090  (site + working /p proxy)
```

Double-click **`start.bat`** on Windows for the same thing. It uses port 8090
and automatically moves to 8091, 8092, … if that port is busy (the URL is
printed in the console).

Static-only preview (games work; the proxy shows a "proxy endpoint not
found" hint because `/p` does not exist):

```powershell
py -m http.server 8090 --directory public
```

With Node installed, Cloudflare's own runtime does the same job:

```powershell
npx wrangler pages dev public
```

Production still needs the Worker / Pages Function described below — the
Python server is only for local testing.

---

## Deploy

You need two pieces:

1. somewhere free to host the static site, and
2. somewhere free to run the proxy.

The easiest combination is **Cloudflare Pages** for both.

### Option A — Cloudflare Pages (site + proxy, recommended)

Everything in one project. Free tier: unlimited static requests, 100,000
Function requests/day.

1. Put this folder in a GitHub repository.
2. Cloudflare dashboard → **Workers & Pages → Create → Pages →
   Connect to Git** → pick the repo.
3. Build settings:
   - **Framework preset:** None
   - **Build command:** *(leave empty)*
   - **Build output directory:** `public`
4. **Save and Deploy.** The `functions/` folder is detected automatically.
5. Open `https://your-project.pages.dev`.

The proxy is live at `/p`, which is already the default in
`public/assets/config.js` (`proxyBase: "p"`).

> Tips
> - `*.pages.dev` domains are sometimes filtered. Add a cheap custom domain
>   (Cloudflare → Pages → Custom domains) for a much higher chance of working.
> - Adding a custom domain to your **Worker** as well keeps the proxy on its
>   own origin, which is safer for browsing arbitrary sites.

### Option B — Worker proxy + any static host

Use this if you want the site on GitHub Pages, Netlify, Vercel, or a school
server, and the proxy somewhere else.

1. Cloudflare dashboard → **Workers & Pages → Create → Worker**.
2. Open `proxy/worker.standalone.js`, copy **the whole file**, paste it into
   the editor, and click **Deploy**.
   (Or with Node: `npx wrangler deploy` — uses `worker.js` + `wrangler.toml`.)
3. Copy the URL it gives you, e.g. `https://ant-proxy.you.workers.dev`.
4. Edit `public/assets/config.js`:

   ```js
   proxyBase: "https://ant-proxy.you.workers.dev/p",
   ```

   You can also paste this into the site's **Settings → Proxy endpoint**, but
   editing the file means every visitor gets it.
5. Upload the **contents of `public/`** to your host:
   - **Netlify:** drag the `public` folder onto app.netlify.com/drop
   - **GitHub Pages:** see [`docs/DEPLOY-GITHUB-PAGES.md`](docs/DEPLOY-GITHUB-PAGES.md)
     (uses the included Actions workflow and a `PROXY_BASE` variable)
   - **Vercel:** `vercel deploy public`

### Option C — Wrangler CLI

```powershell
npm install -g wrangler
wrangler login

# Proxy only (prints a workers.dev URL)
wrangler deploy

# Site + proxy together
wrangler pages deploy public
```

### Option D — GitHub Pages site + Worker proxy (recommended free combo)

GitHub Pages is static-only, so it hosts the arcade and the Worker hosts the
proxy. The repo ships an Actions workflow that publishes `public/` and injects
the Worker URL at build time.

Full walkthrough: [`docs/DEPLOY-GITHUB-PAGES.md`](docs/DEPLOY-GITHUB-PAGES.md).
Short version:

1. Push this repo to GitHub.
2. **Settings → Pages → Source: GitHub Actions.**
3. Deploy `proxy/worker.standalone.js` to a free Cloudflare Worker and copy
   its `/p` URL.
4. **Settings → Secrets and variables → Actions → Variables**, add
   `PROXY_BASE = https://ant-proxy.you.workers.dev/p`.
5. Re-run the *Deploy Ant Arcade to GitHub Pages* workflow.

---

## DuckDuckGo search through the proxy

There are three ways to search, all going through `/p`:

1. **Homepage box** — type a query, hit **Search**. It opens the proxy at
   `html.duckduckgo.com/html/?q=…`.
2. **Proxy address bar** — type words (not a URL) and hit Go; anything that
   isn't a URL or a domain becomes a search on the engine you picked.
3. **Engine picker** — the dropdown in the proxy bar switches between
   DuckDuckGo, DuckDuckGo Lite, Mojeek, Brave and Wikipedia. The choice is
   remembered per browser. This is the quickest fix if one engine starts
   showing a bot-check page.

Why the `html.` endpoint? It is a JavaScript-free version of DuckDuckGo that a
rewriting proxy can actually handle. Its search form uses `POST`, so the
injected shim converts it to `GET` — that way the query stays in the address
bar and the back/forward buttons keep working.

To change the engines or their order, edit `searchEngines` in
`public/assets/config.js`. The first entry is the default:

```js
searchEngines: [
  { id: "ddg", label: "DuckDuckGo", search: "https://html.duckduckgo.com/html/?q=", home: "https://html.duckduckgo.com/html/" },
  { id: "mojeek", label: "Mojeek", search: "https://www.mojeek.com/search?q=", home: "https://www.mojeek.com/" },
],
```

**If search ever shows a "bots use DuckDuckGo too" page:** that's DuckDuckGo
rate-limiting Cloudflare's datacenter IPs, not a bug in your deployment.
Options: switch the picker to **DDG Lite** or **Mojeek**, wait a while, or add
a custom domain to the Worker (different egress).

---

## How the proxy works

`/p?u=<base64url of the target URL>` — for example
`/p?u=aHR0cHM6Ly9leGFtcGxlLmNvbS8`.

What it does:

- fetches the target with a desktop Chrome user agent;
- strips frame-busting headers (`X-Frame-Options`, CSP) so it can be iframed;
- rewrites `src`, `href`, `xlink:href`, `action`, `poster`, `data`, `ping`,
  `srcset`, `style`/`<style>` CSS `url()`, `@import`, `<base>`, meta-refresh
  and `Refresh` response headers;
- follows redirects, re-maps `Location` back through the proxy, and rewrites
  relative links against the *final* URL after a redirect;
- falls back to a followed redirect if the runtime hands back an opaque
  `manual` redirect response;
- injects a small shim that patches `fetch`, `XMLHttpRequest`, `setAttribute`,
  image/script/iframe `src`, `window.open`, `history.pushState` and form
  submission, and reports each navigation back to the arcade UI;
- upgrades `text/plain` pages that actually contain HTML into real documents
  (this is what makes some CDN-hosted games work);
- caches static assets for 10 minutes, never caches HTML.

What it deliberately does **not** do:

- no cookies, no `Authorization`, no `Origin` forwarding (the decoded page URL
  is sent as `Referer`, the same as a normal browser would);
- no `localhost`, private IP, link-local or metadata hostnames (SSRF guard);
- only ports 80 and 443;
- no WebSocket support (so live chat, some multiplayer and streaming sites
  will not work).

It is a *best-effort* browser, not a VPN. JavaScript-heavy SPAs, Google
properties, YouTube and logins generally will not work.

---

## Make it yours

### Add a game

Append to `public/assets/games.js`:

```js
{
  id: "my-game",
  title: "My Game",
  category: "Puzzle",
  desc: "One line about it.",
  url: "games/my-game/index.html",   // or an https URL
  emoji: "🎯",
  g1: "#22d3ee", g2: "#8b5cf6",      // card gradient
  tags: ["New"],
  local: true,                        // true if hosted in this repo
}
```

### Change look and behaviour

- `public/assets/config.js` — site name, panic URL, search engine, proxy
  endpoint, "proxy games by default".
- `public/assets/style.css` — all colours live in `:root`.
- Settings gear (in the running site) — tab title, tab icon, panic URL, proxy
  endpoint, proxy-by-default. Saved per browser in `localStorage`.

### Rebuild the standalone worker

After editing `functions/_lib/proxy.js`:

```powershell
py tools/bundle_proxy.py
```

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Proxy backend not connected" card | The site is being served without a proxy. Static hosts (GitHub Pages, `python -m http.server`) cannot run `/p`. Run `py tools/dev_server.py` locally, or on a deployment set the proxy endpoint: `p` on Cloudflare Pages, or the full Worker URL ending in `/p` elsewhere (Settings → Proxy endpoint, or the `PROXY_BASE` Actions variable). |
| Proxy says "That host is blocked" | It's a local/private address. Public sites only. |
| A game shows a wall of text | That CDN serves HTML as `text/plain`. Toggle **Proxy on** in the player bar, or self-host the game. |
| Search results page loads but links don't open | Some DuckDuckGo wrappers are JavaScript-only. Use the results list itself; direct result links are rewritten and work. |
| Worker throws 1101/1102 | Cloudflare error — usually a syntax problem after editing. Re-paste `proxy/worker.standalone.js`. |
| Worker free limits | 100k requests/day, 10 ms CPU per request (this proxy uses far less). |

---

## Deployment safety notes

- A public proxy can be abused. Before sharing your Worker URL widely:
  - keep it on its own origin (a `*.workers.dev` subdomain or custom domain),
    **not** the same origin as your site, so proxied pages can't touch the
    arcade's storage;
  - add a Cloudflare **Rate Limiting** rule, or put Cloudflare **Turnstile** in
    front of `/p`;
  - set a Worker CPU limit and watch the analytics tab.
- Never sign in to anything through the proxy — cookies and auth headers are
  intentionally dropped, and you should not trust arbitrary proxied pages.
- The proxy iframe is sandboxed without `allow-top-navigation`, so a site's
  frame-busting script cannot replace the arcade tab. Keeping the proxy on a
  separate origin (standalone Worker) is still strongly recommended.
- Only play/run content you're allowed to run. Everything here is open-source
  or written for this project, but the network you're on may still have rules
  about proxies and games. Follow them.

## License

MIT for the arcade shell and the Neon games — see [`LICENSE`](LICENSE).
Bundled third-party games keep their own licenses; see
[`public/games/CREDITS.md`](public/games/CREDITS.md).
