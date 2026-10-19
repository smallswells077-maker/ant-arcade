/*
 * Site configuration.
 * Everything here is safe to edit before you deploy.
 */
window.ARCADE_CONFIG = {
  siteName: "Ant Arcade",
  tagline: "Play anything. Anywhere.",

  /*
   * Proxy endpoint.
   *
   * "p" (default) uses the Cloudflare Pages Function in /functions/p.js,
   * which must be deployed together with this folder. That only works on
   * Cloudflare Pages, or when running `wrangler pages dev`.
   *
   * If you host the static site somewhere else (Netlify, GitHub Pages,
   * Vercel...), deploy the standalone Worker and paste its URL here:
   *   proxyBase: "https://your-proxy.your-name.workers.dev/p"
   *
   * You can also change this at runtime in Settings.
   *
   * A deploy hook can inject a full Worker URL at build time: if
   * assets/proxy-config.js sets window.ANT_PROXY_BASE, that wins. GitHub
   * Actions does this when a PROXY_BASE repository variable is set.
   */
  proxyBase: (window.ANT_PROXY_BASE || "p"),

  // Where the panic button sends you. Use a harmless, boring page.
  panicUrl: "https://classroom.google.com/",

  /*
   * Search engine used by the homepage search box and by the proxy address
   * bar whenever you type words instead of a URL.
   *
   * Bing is the default on purpose. The free cloud proxy (Worker / Pages)
   * runs on a datacenter IP, and DuckDuckGo blocks most of those with an
   * "anomaly" challenge. Bing serves normal HTML from datacenter IPs, so
   * search keeps working on the published site. DuckDuckGo is still in the
   * picker and works well from the local preview server.
   */
  searchUrl: "https://www.bing.com/search?q=",

  // Page the proxy opens when you click "Proxy" without a specific URL.
  proxyHome: "https://www.bing.com/",

  /*
   * Search engines offered in the proxy's picker. The first entry is the
   * default. All of these return mostly-plain HTML, which is what a
   * rewriting proxy needs.
   */
  searchEngines: [
    {
      id: "bing",
      label: "Bing",
      search: "https://www.bing.com/search?q=",
      home: "https://www.bing.com/",
    },
    {
      id: "ddg",
      label: "DuckDuckGo",
      search: "https://html.duckduckgo.com/html/?q=",
      home: "https://html.duckduckgo.com/html/",
    },
    {
      id: "ddg-lite",
      label: "DDG Lite",
      search: "https://lite.duckduckgo.com/lite/?q=",
      home: "https://lite.duckduckgo.com/lite/",
    },
    {
      id: "mojeek",
      label: "Mojeek",
      search: "https://www.mojeek.com/search?q=",
      home: "https://www.mojeek.com/",
    },
    {
      id: "brave",
      label: "Brave",
      search: "https://search.brave.com/search?q=",
      home: "https://search.brave.com/",
    },
    {
      id: "wikipedia",
      label: "Wikipedia",
      search: "https://en.wikipedia.org/w/index.php?search=",
      home: "https://en.wikipedia.org/",
    },
  ],

  // Open every game through the proxy by default.
  defaultProxyGames: false,
};
