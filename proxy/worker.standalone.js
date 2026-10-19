/*
 * GENERATED FILE — do not edit by hand.
 * Source: functions/_lib/proxy.js
 * Rebuild: python tools/bundle_proxy.py
 *
 * Paste this whole file into the Cloudflare dashboard Worker editor,
 * then click Deploy.
 */

/**
 * Ant Arcade proxy core.
 *
 * Works as:
 *   - a Cloudflare Pages Function (functions/p.js)
 *   - a standalone Worker (worker.js / proxy/worker.standalone.js)
 *
 * URL format:  /p?u=<base64url of the target URL>
 * Also accepts: /p/<base64url>  (handy for the standalone worker)
 *
 * Notes / limits:
 *   - HTML and CSS are rewritten so most links and assets stay inside the proxy.
 *   - Cookies and Authorization headers are intentionally NOT forwarded; the
 *     decoded page URL is sent as Referer, the same as a normal browser.
 *   - JavaScript-heavy SPAs, WebSockets and sites that hard-code their own origin
 *     may not work perfectly. This is a best-effort browser, not a VPN.
 */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

const STRIPPED_RESPONSE_HEADERS = new Set([
  "content-length", "content-encoding", "transfer-encoding", "connection",
  "keep-alive", "set-cookie", "cookie", "content-disposition",
  "content-security-policy", "content-security-policy-report-only",
  "x-content-security-policy", "x-webkit-csp",
  "x-frame-options", "frame-options",
  "strict-transport-security", "cross-origin-opener-policy",
  "cross-origin-embedder-policy", "cross-origin-resource-policy",
  "permissions-policy", "report-to", "nel", "alt-svc", "server-timing",
  "expect-ct", "location", "x-arcade-proxy",
]);

const STATIC_ASSET_RE = /\.(?:js|mjs|css|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp3|ogg|wav|mp4|webm|glb|gltf|json|xml|txt|wasm)(?:$|\?)/i;

// `location.href = "..."`, `location.replace("...")`, `window.location = "..."`.
// Used to keep inline redirects inside the proxy.
const JS_LOCATION_RE = /((?:window\.|document\.|top\.|parent\.|self\.)?location(?:\.(?:href|assign|replace))?\s*(?:=|\()\s*)(["'])([^"']+)\2/gi;

/* ------------------------------------------------------------------ */
/* entry point                                                        */
/* ------------------------------------------------------------------ */

async function handleProxy(request, env) {
  const requestUrl = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const token = extractToken(requestUrl);
  if (!token) return infoPage(requestUrl);

  const targetRaw = decodeToken(token);
  if (!targetRaw) return errorPage(400, "That proxy link is malformed.");

  let target;
  try {
    target = new URL(targetRaw);
  } catch (e) {
    return errorPage(400, "That proxy link is not a valid URL.");
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return errorPage(400, "Only http and https URLs can be proxied.");
  }
  if (isBlockedHost(target.hostname)) {
    return errorPage(403, "That host is blocked by the proxy.");
  }
  if (target.port && target.port !== "80" && target.port !== "443") {
    return errorPage(403, "Only standard web ports are allowed.");
  }

  if (!env) env = {};

  const upstreamHeaders = buildRequestHeaders(request);
  const init = {
    method: request.method,
    headers: upstreamHeaders,
    redirect: "manual",
    signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout
      ? AbortSignal.timeout(20000)
      : undefined,
  };

  if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
    init.body = request.body;
  }

  let upstream;
  try {
    upstream = await fetch(target.href, init);
  } catch (error) {
    return errorPage(502, "The site could not be reached.", target.hostname);
  }

  /*
   * Some runtimes hand back an opaque response for `redirect: "manual"`
   * (status 0, no readable headers). When that happens, let the runtime
   * follow the redirect chain instead so the page can still be rewritten.
   */
  if (
    (upstream.type === "opaqueredirect" || upstream.status === 0) &&
    (request.method === "GET" || request.method === "HEAD")
  ) {
    const followInit = Object.assign({}, init, { redirect: "follow", body: undefined });
    try {
      upstream = await fetch(target.href, followInit);
    } catch (error) {
      return errorPage(502, "The site could not be reached.", target.hostname);
    }
  }

  /* redirects ------------------------------------------------------ */

  if (upstream.status >= 300 && upstream.status < 400) {
    const location = upstream.headers.get("location");
    const redirectHeaders = baseResponseHeaders(upstream);
    if (location) {
      try {
        redirectHeaders.set("location", proxyHref(new URL(location, target).href, requestUrl.origin));
      } catch (e) {
        redirectHeaders.set("location", proxyHref(target.href, requestUrl.origin));
      }
    }
    return new Response(null, { status: upstream.status, headers: redirectHeaders });
  }

  /* normal responses ----------------------------------------------- */

  // If the runtime followed a redirect, relative links must resolve against
  // the page we actually landed on, not the URL that was requested.
  const page = effectiveUrl(target, upstream);

  const headers = baseResponseHeaders(upstream);
  const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
  const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
  const isCss = contentType.includes("text/css");

  // The `Refresh` response header is a redirect in disguise.
  const refreshHeader = upstream.headers.get("refresh");
  if (refreshHeader) {
    headers.set("refresh", rewriteRefreshHeader(refreshHeader, page, requestUrl.origin));
  }

  try {
    if (isHtml && request.method !== "HEAD") {
      const original = await upstream.text();
      const rewritten = rewriteHtml(original, page, requestUrl.origin);
      headers.set("content-type", "text/html; charset=utf-8");
      headers.set("cache-control", "no-store");
      return new Response(rewritten, { status: upstream.status, headers });
    }

    if (isCss && request.method !== "HEAD") {
      const original = await upstream.text();
      const rewritten = rewriteCss(original, page, requestUrl.origin);
      headers.set("content-type", "text/css; charset=utf-8");
      headers.set("cache-control", "private, max-age=300");
      return new Response(rewritten, { status: upstream.status, headers });
    }

    const isJs = contentType.includes("javascript") || contentType.includes("ecmascript");
    if (isJs && request.method !== "HEAD") {
      const original = await upstream.text();
      const rewritten = rewriteJs(original, page, requestUrl.origin);
      headers.set("content-type", upstream.headers.get("content-type") || "application/javascript; charset=utf-8");
      headers.set("cache-control", "private, max-age=300");
      return new Response(rewritten, { status: upstream.status, headers });
    }

    /*
     * Some CDNs (jsDelivr, for example) serve .html files as text/plain to
     * stop people from using them as a free web host. If the body actually
     * looks like a document, treat it as one anyway.
     */
    const maybeDocument =
      request.method !== "HEAD" &&
      !STATIC_ASSET_RE.test(page.pathname) &&
      (contentType.indexOf("text/plain") === 0 ||
        contentType.indexOf("application/octet-stream") === 0 ||
        contentType === "");

    if (maybeDocument) {
      const body = await upstream.text();
      if (/^\s*(?:<!doctype\s+html|<html[\s>]|<!--)/i.test(body)) {
        const rewritten = rewriteHtml(body, page, requestUrl.origin);
        headers.set("content-type", "text/html; charset=utf-8");
        headers.set("cache-control", "no-store");
        return new Response(rewritten, { status: upstream.status, headers });
      }
      headers.set("content-type", upstream.headers.get("content-type") || "text/plain; charset=utf-8");
      headers.set("cache-control", "no-store");
      return new Response(body, { status: upstream.status, headers });
    }
  } catch (error) {
    return errorPage(502, "The page was received but could not be processed.", target.hostname);
  }

  if (STATIC_ASSET_RE.test(page.pathname)) {
    headers.set("cache-control", "private, max-age=600");
  } else {
    headers.set("cache-control", "no-store");
  }

  if (upstream.status === 204 || upstream.status === 205 || upstream.status === 304) {
    return new Response(null, { status: upstream.status, headers });
  }

  return new Response(upstream.body, { status: upstream.status, headers });
}

/* ------------------------------------------------------------------ */
/* request / response plumbing                                        */
/* ------------------------------------------------------------------ */

function buildRequestHeaders(request) {
  const headers = new Headers();

  request.headers.forEach(function (value, key) {
    const name = key.toLowerCase();
    if (HOP_BY_HOP.has(name)) return;
    if (name === "host" || name === "cookie" || name === "authorization") return;
    if (name === "referer" || name === "origin") return;
    if (name.startsWith("cf-") || name.startsWith("x-forwarded") || name.startsWith("x-real-ip")) return;
    if (name.startsWith("sec-fetch")) return;
    headers.set(name, value);
  });

  headers.set("user-agent", USER_AGENT);
  headers.set("accept-language", "en-US,en;q=0.9");

  /*
   * Send the real page URL as Referer instead of the /p address. A handful of
   * sites (and some redirect endpoints) behave differently without it.
   */
  const referer = targetFromReferer(request.headers.get("referer"));
  if (referer) headers.set("referer", referer);
  /*
   * Do NOT set Accept-Encoding here. The runtime negotiates and decodes
   * compression itself, and taking that over can hand us a gzipped body we
   * then try to rewrite as text.
   */

  return headers;
}

function baseResponseHeaders(upstream) {
  const headers = new Headers();

  upstream.headers.forEach(function (value, key) {
    const name = key.toLowerCase();
    if (STRIPPED_RESPONSE_HEADERS.has(name)) return;
    headers.set(key, value);
  });

  corsHeaders().forEach(function (value, key) { headers.set(key, value); });
  headers.set("x-arcade-proxy", "1");

  return headers;
}

function corsHeaders() {
  const headers = new Headers();
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, HEAD, POST, OPTIONS");
  headers.set("access-control-allow-headers", "*");
  headers.set("access-control-expose-headers", "*");
  return headers;
}

/* ------------------------------------------------------------------ */
/* URL helpers                                                        */
/* ------------------------------------------------------------------ */

function proxiedPath(origin) {
  return origin.replace(/\/+$/, "") + "/p";
}

function proxyHref(target, origin) {
  return proxiedPath(origin) + "?u=" + encodeToken(target);
}

/*
 * Where a response actually came from. When the runtime follows redirects,
 * `upstream.url` is the final location, and relative links in the body must be
 * resolved against that.
 */
function effectiveUrl(requested, upstream) {
  try {
    const finalUrl = upstream.url;
    if (!finalUrl || finalUrl === requested.href) return requested;
    const final = new URL(finalUrl);
    /*
     * Bing redirects cookie-less search requests through /geolocation/write
     * and then renders the results at that URL. The body is the search page,
     * but the geolocation URL is not reloadable (and makes the address bar
     * useless), so keep the URL the user actually asked for.
     */
    if (/(^|\.)bing\.com$/i.test(final.hostname) &&
        final.pathname.replace(/\/+$/, "") === "/geolocation/write") {
      return requested;
    }
    return final;
  } catch (e) { /* ignore */ }
  return requested;
}

function rewriteRefreshHeader(value, pageUrl, origin) {
  return String(value).replace(/url\s*=\s*(['"]?)([^'";]+)\1/gi, function (match, quote, url) {
    return "url=" + rewriteUrl(url.trim(), pageUrl, origin);
  });
}

function extractToken(requestUrl) {
  const fromQuery = requestUrl.searchParams.get("u");
  if (fromQuery) return fromQuery;

  let path = requestUrl.pathname;
  path = path.replace(/^\/p\/?/, "");
  return path || "";
}

function encodeToken(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeToken(value) {
  try {
    let b64 = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
    b64 += "=".repeat((4 - (b64.length % 4)) % 4);
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch (e) {
    return null;
  }
}

function targetFromReferer(value) {
  if (!value) return null;
  let ref;
  try {
    ref = new URL(value);
  } catch (e) {
    return null;
  }
  if (ref.pathname !== "/p" && !ref.pathname.startsWith("/p/")) return null;

  let token = ref.searchParams.get("u");
  if (!token && ref.pathname.startsWith("/p/")) token = ref.pathname.slice(3);
  const target = token ? decodeToken(token) : null;
  if (!target) return null;

  try {
    const parsed = new URL(target);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.href;
  } catch (e) {
    return null;
  }
}

function isBlockedHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");

  if (!host) return true;
  if (host === "localhost" || host === "::1" || host === "0.0.0.0") return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) return true;
  if (host.endsWith(".localhost")) return true;

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split(".").map(Number);
    if (parts[0] === 0 || parts[0] === 10 || parts[0] === 127) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  }

  if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;

  return false;
}

/* ------------------------------------------------------------------ */
/* HTML / CSS rewriting                                               */
/* ------------------------------------------------------------------ */

// Form actions are deliberately NOT rewritten: the injected shim intercepts
// submits and proxies them itself, and it needs the original action URL to
// rebuild the target. Rewriting action broke DuckDuckGo's POST search form.
const URL_ATTR_RE = /(\s)((?:xlink:)?href|src|poster|data|background|cite|longdesc|manifest|ping)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
const SRCSET_RE = /(\s)(srcset|imagesrcset)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const META_REFRESH_RE = /(<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*)(["'])([^"']*)\2/gi;

const HTML_ENTITIES = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };

// Attribute values in raw HTML still contain entities like &amp;. Decode them
// before parsing URLs, then re-escape once on output.
function decodeEntities(value) {
  return String(value == null ? "" : value)
    .replace(/&#x([0-9a-f]+);?/gi, function (match, hex) {
      const code = parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    })
    .replace(/&#(\d+);?/g, function (match, dec) {
      const code = parseInt(dec, 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    })
    .replace(/&(amp|quot|apos|lt|gt);/gi, function (match, name) {
      return HTML_ENTITIES[name.toLowerCase()];
    });
}

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function rewriteRefreshContent(content, pageUrl, origin) {
  return String(content).replace(/url\s*=\s*([^;]+)/i, function (_m, url) {
    const clean = String(url).trim().replace(/^['"]|['"]$/g, "");
    return "url=" + rewriteUrl(clean, pageUrl, origin);
  });
}

function rewriteHtml(html, pageUrl, origin) {
  let output = String(html);

  // A <base> tag would break our generated links; relative URLs are resolved
  // against the real page URL instead.
  output = output.replace(/<base\b[^>]*>/gi, "");

  output = output.replace(SRCSET_RE, function (match, space, attr, _all, dq, sq, uq) {
    const value = decodeEntities(dq != null ? dq : sq != null ? sq : uq != null ? uq : "");
    if (/data:/i.test(value)) return match;
    const rewritten = rewriteSrcset(value, pageUrl, origin);
    return space + attr + '="' + escapeAttribute(rewritten) + '"';
  });

  output = output.replace(URL_ATTR_RE, function (match, space, attr, _all, dq, sq, uq) {
    const value = decodeEntities(dq != null ? dq : sq != null ? sq : uq != null ? uq : "");
    const rewritten = rewriteUrl(value, pageUrl, origin);
    return space + attr + '="' + escapeAttribute(rewritten) + '"';
  });

  // Inline and embedded CSS.
  output = output.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, function (match, open, css, close) {
    return open + rewriteCss(css, pageUrl, origin) + close;
  });

  output = output.replace(/(\sstyle\s*=\s*)("([^"]*)"|'([^']*)')/gi, function (match, prefix, _all, dq, sq) {
    const value = decodeEntities(dq != null ? dq : sq != null ? sq : "");
    return prefix + '"' + escapeAttribute(rewriteCss(value, pageUrl, origin)) + '"';
  });

  output = output.replace(META_REFRESH_RE, function (match, prefix, quote, content) {
    const rewritten = rewriteRefreshContent(decodeEntities(content), pageUrl, origin);
    return prefix + quote + escapeAttribute(rewritten) + quote;
  });

  // Same thing, but for tags written with `content` before `http-equiv`.
  output = output.replace(/<meta\b[^>]*>/gi, function (tag) {
    if (!/http-equiv\s*=\s*["']?\s*refresh/i.test(tag)) return tag;
    if (/http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=/i.test(tag)) return tag; // already handled
    return tag.replace(/(content\s*=\s*)(["'])([^"']*)\2/i, function (match, prefix, quote, content) {
      const rewritten = rewriteRefreshContent(decodeEntities(content), pageUrl, origin);
      return prefix + quote + escapeAttribute(rewritten) + quote;
    });
  });

  // Keep inline JavaScript redirects (`location.replace("...")` and friends)
  // inside the proxy. Entity characters are left as-is because <script> bodies
  // are raw text, not entity-decoded HTML.
  output = output.replace(JS_LOCATION_RE, function (match, prefix, quote, url) {
    const rewritten = rewriteUrl(url, pageUrl, origin);
    if (rewritten === url) return match;
    return prefix + quote + rewritten + quote;
  });

  return injectShim(output, pageUrl, origin);
}

function rewriteJs(js, pageUrl, origin) {
  /*
   * SPAs with code-splitting load chunks via dynamic import("/..."). Those
   * root-relative paths resolve against the proxy origin, bypassing the proxy.
   * Rewrite them to proxied URLs so the chunks load.
   */
  const page = pageUrl;
  return String(js).replace(
    /import\s*\(\s*(['"])(\/[^'"]*)\1/g,
    function (match, quote, path) {
      try {
        const target = new URL(path, page);
        return "import(" + quote + proxyHref(target.href, origin) + quote + ")";
      } catch (e) {
        return match;
      }
    }
  );
}
function rewriteCss(css, pageUrl, origin) {
  return String(css)
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, function (match, quote, url) {
      const rewritten = rewriteUrl(url, pageUrl, origin);
      if (rewritten === url) return match;
      return "url(" + quote + rewritten + quote + ")";
    })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, function (match, quote, url) {
      const rewritten = rewriteUrl(url, pageUrl, origin);
      if (rewritten === url) return match;
      return '@import "' + rewritten + '"';
    });
}

function rewriteSrcset(value, pageUrl, origin) {
  return String(value).split(",").map(function (part) {
    const trimmed = part.trim();
    if (!trimmed) return part;
    const pieces = trimmed.split(/\s+/);
    pieces[0] = rewriteUrl(pieces[0], pageUrl, origin);
    return pieces.join(" ");
  }).join(", ");
}

function rewriteUrl(rawValue, pageUrl, origin) {
  const value = String(rawValue == null ? "" : rawValue).trim();
  if (!value) return rawValue;
  if (/^(?:#|data:|blob:|javascript:|mailto:|tel:|sms:|about:|chrome:|chrome-extension:|moz-extension:|intent:|file:)/i.test(value)) {
    return rawValue;
  }

  let absolute;
  try {
    absolute = new URL(value, pageUrl);
  } catch (e) {
    return rawValue;
  }

  if (absolute.protocol !== "http:" && absolute.protocol !== "https:") return rawValue;

  // Unwrap DuckDuckGo's /l/?uddg=<target> result redirects so the browser goes
  // straight to the destination instead of a JavaScript interstitial.
  try {
    if (/(^|\.)duckduckgo\.com$/i.test(absolute.hostname) &&
        absolute.pathname.replace(/\/+$/, "") === "/l" &&
        absolute.searchParams.has("uddg")) {
      const destination = new URL(absolute.searchParams.get("uddg"));
      if (destination.protocol === "http:" || destination.protocol === "https:") {
        absolute = destination;
      }
    }
  } catch (e) { /* ignore */ }

  // Unwrap Bing's /ck/a click-tracking redirects (u=a1<base64url target>).
  try {
    if (/(^|\.)bing\.com$/i.test(absolute.hostname) &&
        absolute.pathname.replace(/\/+$/, "") === "/ck/a" &&
        absolute.searchParams.has("u")) {
      let raw = absolute.searchParams.get("u") || "";
      if (raw.indexOf("a1") === 0) raw = raw.slice(2);
      const decoded = decodeToken(raw);
      if (decoded) {
        const destination = new URL(decoded);
        if (destination.protocol === "http:" || destination.protocol === "https:") {
          absolute = destination;
        }
      }
    }
  } catch (e) { /* ignore */ }

  // Already proxied?
  try {
    const site = new URL(origin);
    if (absolute.origin === site.origin && absolute.pathname === "/p" && absolute.searchParams.has("u")) {
      return value;
    }
  } catch (e) { /* ignore */ }

  return proxyHref(absolute.href, origin);
}

/* ------------------------------------------------------------------ */
/* runtime shim injected into proxied pages                           */
/* ------------------------------------------------------------------ */

function injectShim(html, pageUrl, origin) {
  const shim = "<script>" + buildShim(pageUrl.href, origin) + "</script>";

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, function (match) { return match + shim; });
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, function (match) { return match + shim; });
  }
  return shim + html;
}

function buildShim(pageUrl, origin) {
  const targetLiteral = JSON.stringify(pageUrl);
  const proxyLiteral = JSON.stringify(proxiedPath(origin));

  return `
(function () {
  var T = ${targetLiteral};
  var P = ${proxyLiteral};
  var HOST = "";
  try { HOST = new URL(T).hostname.toLowerCase(); } catch (e) {}
  var SEARCH_POST = /(^|\\.)duckduckgo\\.com$/i;
  var ENC = function (value) {
    try {
      var bytes = new TextEncoder().encode(value);
      var binary = "";
      for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
    } catch (e) { return ""; }
  };
  var PROX = function (value) {
    if (!value) return value;
    var text = String(value);
    if (/^(?:#|data:|blob:|javascript:|mailto:|tel:|sms:|about:|chrome:|chrome-extension:|moz-extension:)/i.test(text)) return value;
    if (text.indexOf(P + "?u=") === 0) return value;
    var proxyPath = "";
    try { proxyPath = new URL(P).pathname; } catch (e) {}
    // A page that copies location.pathname + location.search can hand us the
    // proxy's own /p?u= path. Do not wrap that a second time.
    if (proxyPath && text.charAt(0) === "/" && text.indexOf(proxyPath + "?u=") === 0) return value;
    try {
      var url = new URL(text, T);
      if (url.protocol !== "http:" && url.protocol !== "https:") return value;
      if (proxyPath && url.pathname === proxyPath && url.searchParams.has("u")) return P + url.search;
      if (url.origin === location.origin && url.pathname === new URL(P).pathname) return value;
      return P + "?u=" + ENC(url.href);
    } catch (e) { return value; }
  };

  try { parent.postMessage({ __arcadeProxy: true, url: T }, "*"); } catch (e) {}

  // fetch
  try {
    var nativeFetch = window.fetch;
    if (nativeFetch) {
      window.fetch = function (input, init) {
        try {
          if (typeof input === "string" || input instanceof URL) {
            input = PROX(String(input));
          } else if (input && typeof input === "object" && input.url) {
            input = new Request(PROX(input.url), input);
          }
        } catch (e) {}
        return nativeFetch.call(this, input, init);
      };
    }
  } catch (e) {}

  // XMLHttpRequest
  try {
    var nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      args[1] = PROX(url);
      return nativeOpen.apply(this, args);
    };
  } catch (e) {}

  // Dynamic element URLs.
  try {
    var nativeSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      var key = String(name).toLowerCase();
      if (key === "src" || key === "href" || key === "poster" || key === "data" || key === "srcset") {
        try {
          if (key === "srcset") {
            value = String(value).split(",").map(function (part) {
              var bits = part.trim().split(/\\s+/);
              if (bits[0]) bits[0] = PROX(bits[0]);
              return bits.join(" ");
            }).join(", ");
          } else {
            value = PROX(value);
          }
        } catch (e) {}
      }
      return nativeSetAttribute.call(this, name, value);
    };
  } catch (e) {}

  // Property setters used by game engines.
  function patchSrc(proto, prop) {
    try {
      var desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (!desc || !desc.set) return;
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set: function (value) { return desc.set.call(this, PROX(value)); }
      });
    } catch (e) {}
  }
  try { patchSrc(HTMLImageElement.prototype, "src"); } catch (e) {}
  try { patchSrc(HTMLScriptElement.prototype, "src"); } catch (e) {}
  try { patchSrc(HTMLIFrameElement.prototype, "src"); } catch (e) {}
  try { patchSrc(HTMLMediaElement.prototype, "src"); } catch (e) {}
  try { patchSrc(HTMLSourceElement.prototype, "src"); } catch (e) {}
  try { patchSrc(HTMLSourceElement.prototype, "srcset"); } catch (e) {}
  try { patchSrc(HTMLLinkElement.prototype, "href"); } catch (e) {}
  try { patchSrc(HTMLAnchorElement.prototype, "href"); } catch (e) {}
  try { patchSrc(HTMLFormElement.prototype, "action"); } catch (e) {}

  /*
   * Forms. GET forms are folded into the proxied URL so the query string
   * survives (and stays visible in the address bar). DuckDuckGo's HTML
   * endpoints use POST for search, but accept GET too, so we convert those.
   */
  try {
    document.addEventListener("submit", function (event) {
      var form = event.target;
      if (!form || String(form.tagName).toUpperCase() !== "FORM") return;
      var method = String(form.getAttribute("method") || "get").toLowerCase();
      var isGet = method === "get";
      var isSearchPost = method === "post" && SEARCH_POST.test(HOST);
      if (!isGet && !isSearchPost) return;
      event.preventDefault();
      try {
        var action = new URL(form.getAttribute("action") || T, T);
        new FormData(form).forEach(function (value, key) {
          if (typeof value === "string") action.searchParams.append(key, value);
        });
        location.href = PROX(action.href);
      } catch (e) {}
    }, true);
  } catch (e) {}

  // window.open
  try {
    var nativeOpenWindow = window.open;
    window.open = function (url) {
      var args = Array.prototype.slice.call(arguments);
      if (url) args[0] = PROX(url);
      return nativeOpenWindow.apply(window, args);
    };
  } catch (e) {}

  // history.pushState / replaceState
  try {
    var patchHistory = function (name) {
      var original = history[name];
      if (!original) return;
      history[name] = function (state, title, url) {
        if (url) {
          try { url = PROX(new URL(url, T).href); } catch (e) {}
        }
        return original.call(history, state, title, url);
      };
    };
    patchHistory("pushState");
    patchHistory("replaceState");
  } catch (e) {}
})();`.replace(/<\/script>/gi, "<\\/script>");
}

/* ------------------------------------------------------------------ */
/* landing / error pages                                              */
/* ------------------------------------------------------------------ */

function pageShell(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Proxy</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    background: radial-gradient(circle at 50% 0%, #14203a, #05070f 60%);
    color: #e8eef9; font-family: "Segoe UI", system-ui, sans-serif;
  }
  .card {
    width: min(520px, 100%); padding: 28px; border: 1px solid rgba(148,163,184,.18);
    border-radius: 18px; background: rgba(11,18,32,.9);
    box-shadow: 0 30px 80px rgba(0,0,0,.5);
  }
  h1 { margin: 0 0 8px; font-size: 24px; letter-spacing: -.02em; }
  p { margin: 0 0 18px; color: #8d9db6; font-size: 14px; line-height: 1.6; }
  form { display: flex; gap: 8px; }
  input {
    flex: 1; min-width: 0; height: 44px; padding: 0 12px; border: 1px solid rgba(148,163,184,.22);
    border-radius: 10px; outline: 0; background: rgba(255,255,255,.04); color: #e8eef9; font: inherit;
  }
  input:focus { border-color: rgba(34,211,238,.5); }
  button {
    height: 44px; padding: 0 18px; border: 0; border-radius: 10px; cursor: pointer;
    background: linear-gradient(115deg,#22d3ee,#8b5cf6); color: #05070f; font-weight: 800;
  }
  code { padding: 1px 5px; border-radius: 4px; background: rgba(255,255,255,.06); font-size: 12px; }
  .foot { margin-top: 16px; font-size: 11.5px; color: #66768e; }
  .btnline { margin-top: 18px; }
  .btnline a {
    display: inline-block; padding: 9px 14px; border: 1px solid rgba(148,163,184,.22);
    border-radius: 9px; color: #cfe0f5; text-decoration: none; font-size: 13px; font-weight: 600;
  }
</style>
</head>
<body>
  <div class="card">${body}</div>
</body>
</html>`;
}

function infoPage(requestUrl) {
  const base = proxiedPath(requestUrl.origin);

  const body = `
    <h1>Proxy endpoint</h1>
    <p>This is the Ant Arcade proxy. Enter a URL to browse it through this worker.</p>
    <form id="f">
      <input id="u" type="text" placeholder="example.com" autocomplete="off" spellcheck="false" autofocus>
      <button type="submit">Open</button>
    </form>
    <p class="foot">
      Link format: <code>/p?u=&lt;base64url&gt;</code>. Cookies and logins are not
      forwarded, so some sites will not work.
    </p>
    <div class="btnline"><a href="/">Back to the arcade</a></div>
    <script>
      document.getElementById("f").addEventListener("submit", function (event) {
        event.preventDefault();
        var raw = document.getElementById("u").value.trim();
        if (!raw) return;
        if (!/^https?:\\/\\//i.test(raw)) raw = "https://" + raw;
        var bytes = new TextEncoder().encode(raw);
        var binary = "";
        for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        var token = btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
        location.href = ${JSON.stringify(base)} + "?u=" + token;
      });
    </script>`;

  return new Response(pageShell("Proxy", body), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function errorPage(status, message, detail) {
  const body = `
    <h1>${escapeHtml(message)}</h1>
    <p>${detail ? "Host: <code>" + escapeHtml(detail) + "</code>" : "Try another URL or go back to the arcade."}</p>
    <div class="btnline"><a href="/">Back to the arcade</a></div>`;

  return new Response(pageShell("Proxy error", body), {
    status: status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default {
  async fetch(request, env) {
    return handleProxy(request, env);
  },
};
