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
   * The "html." endpoint is a plain-HTML page with no JavaScript, which is
   * exactly what a proxy can handle cleanly.
   */
  searchUrl: "https://html.duckduckgo.com/html/?q=",

  // Page the proxy opens when you click "Proxy" without a specific URL.
  proxyHome: "https://html.duckduckgo.com/html/",

  /*
   * Search engines offered in the proxy's picker. The first entry is the
   * default. All of these return mostly-plain HTML, which is what a
   * rewriting proxy needs. If DuckDuckGo ever throttles your Worker's
   * datacenter IP, switching to Mojeek or DuckDuckGo Lite usually fixes it.
   */
  searchEngines: [
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
