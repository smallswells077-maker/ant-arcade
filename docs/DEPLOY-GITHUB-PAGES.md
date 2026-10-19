# Deploying Ant Arcade to GitHub Pages

GitHub Pages is **free and static-only**. That means it can host the arcade,
all seven self-hosted games and the whole UI — but it **cannot run the web
proxy**, because the proxy needs a server.

So a public GitHub Pages deployment has two pieces:

| Piece | Where it runs | What it does |
| --- | --- | --- |
| `public/` | GitHub Pages (`*.github.io`) | The arcade, games, search UI |
| `worker.js` | Cloudflare Workers (free) | The `/p` proxy + DuckDuckGo search |

Until the Worker exists, the published site shows a **"Proxy backend not
connected"** card when you open the proxy. Games always work.

---

## 1. Put the project on GitHub

You need a GitHub account and a repository. Two ways:

### Option A — without git (web upload)

1. On <https://github.com/new>, create a repository (e.g. `ant-arcade`).
   Public is required for free Pages.
2. On the new repo page, choose **uploading an existing file**.
3. Drag in **everything inside the `ant-arcade` folder** (not the folder
   itself): `public/`, `functions/`, `proxy/`, `tools/`, `.github/`,
   `worker.js`, `wrangler.toml`, `start.bat`, `README.md`, `LICENSE`.
   `.github/` is hidden but will be included if you select it.
4. Commit to the `main` branch.

### Option B — with git

```bash
cd ant-arcade
git init
git add .
git commit -m "Ant Arcade"
git branch -M main
git remote add origin https://github.com/<you>/ant-arcade.git
git push -u origin main
```

---

## 2. Turn on Pages

1. Repo → **Settings → Pages**.
2. Under **Build and deployment → Source**, pick **GitHub Actions**.
3. The included workflow (`.github/workflows/pages.yml`) runs on every push to
   `main` and publishes the `public/` folder.
4. Wait for the green check in the **Actions** tab, then open
   `https://<you>.github.io/<repo>/`.

Games and search UI work now. The proxy needs step 3.

---

## 3. Deploy the proxy Worker (free)

1. Sign in at <https://dash.cloudflare.com> (free account).
2. **Workers & Pages → Create → Workers → Create Worker**.
3. Give it a name such as `ant-proxy`, then **Deploy**.
4. Choose **Edit code**, delete everything in the editor.
5. Open `proxy/worker.standalone.js` from this repo, copy **the whole file**,
   paste it into the editor, and **Deploy**.
6. Copy the URL it shows, e.g. `https://ant-proxy.you.workers.dev`.
   The proxy endpoint is that URL plus `/p`:
   `https://ant-proxy.you.workers.dev/p`

Test it in a browser:

```
https://ant-proxy.you.workers.dev/p?u=aHR0cHM6Ly9leGFtcGxlLmNvbS8
```

You should see the example.com page.

> Prefer the CLI? `npx wrangler deploy` from this folder uses `worker.js` +
> `wrangler.toml`. The included `deploy-worker.yml` workflow can also do it
> automatically once you add `CLOUDFLARE_API_TOKEN` and
> `CLOUDFLARE_ACCOUNT_ID` repository secrets.

---

## 4. Connect the site to the Worker

Tell the Pages build where the proxy lives.

1. Repo → **Settings → Secrets and variables → Actions → Variables**.
2. **New repository variable**:
   - Name: `PROXY_BASE`
   - Value: `https://ant-proxy.you.workers.dev/p`
3. Re-run the Pages workflow (Actions → *Deploy Ant Arcade to GitHub Pages*
   → **Re-run all jobs**), or push any commit.

The build writes that value into `public/assets/proxy-config.js`, and the
published site talks to your Worker. DuckDuckGo search and URL browsing now
work on the `*.github.io` URL.

> Don't want a build-time variable? Open the deployed site →
> **Settings → Proxy endpoint**, paste the Worker URL, and save. That only
> affects your own browser, but it is handy for testing.

---

## Notes and gotchas

- **The proxy and the site should be on different origins.** The Worker is on
  `*.workers.dev`, the site on `*.github.io`, so proxied pages cannot touch the
  arcade's `localStorage`. Keep it that way.
- **`*.github.io` and `*.workers.dev` are sometimes filtered** on school
  networks. A cheap custom domain (Cloudflare DNS) usually gets through.
- **Repo name = URL path.** `https://<you>.github.io/ant-arcade/`. All asset
  links are relative, so subpaths work out of the box.
- **Soft 404s:** the app uses hash routing (`#games`, `#proxy/...`), so no
  server-side routes are needed.
- **A public proxy can be abused.** Add a Cloudflare rate-limit rule or
  Turnstile in front of `/p` before sharing the Worker URL widely. See the
  "Deployment safety notes" section of the main `README.md`.
