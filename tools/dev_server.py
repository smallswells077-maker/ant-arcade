#!/usr/bin/env python3
"""
Ant Arcade — local preview server with a working proxy.

`python -m http.server` can only serve files, so /p returns 404 and the
built-in proxy looks broken. This script serves the same `public/` folder AND
implements /p in Python, with the same rewriting rules as the Cloudflare
Worker. No Node, no wrangler, no account needed.

    py tools/dev_server.py
    py tools/dev_server.py --port 9000 --no-open

Production still uses the Cloudflare Worker / Pages Function. This is only for
local preview and LAN testing.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import html
import http.client
import http.server
import ipaddress
import json
import re
import socket
import ssl
import sys
import threading
import time
import urllib.parse
import webbrowser
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "public"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

STRIPPED_RESPONSE_HEADERS = {
    "content-length", "content-encoding", "transfer-encoding", "connection",
    "keep-alive", "set-cookie", "cookie", "content-disposition",
    "content-security-policy", "content-security-policy-report-only",
    "x-content-security-policy", "x-webkit-csp",
    "x-frame-options", "frame-options",
    "strict-transport-security", "cross-origin-opener-policy",
    "cross-origin-embedder-policy", "cross-origin-resource-policy",
    "permissions-policy", "report-to", "nel", "alt-svc", "server-timing",
    "expect-ct", "location", "x-arcade-proxy",
}

STATIC_ASSET_RE = re.compile(
    r"\.(?:js|mjs|css|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|"
    r"mp3|ogg|wav|mp4|webm|glb|gltf|json|xml|txt|wasm)(?:$|\?)",
    re.I,
)

# Form actions are deliberately NOT rewritten: the injected shim intercepts
# submits and proxies them itself, and it needs the original action URL.
URL_ATTR_RE = re.compile(
    r"""(\s)((?:xlink:)?href|src|poster|data|background|cite|longdesc|manifest|ping)"""
    r"""\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))""",
    re.I,
)
SRCSET_RE = re.compile(
    r"""(\s)(srcset|imagesrcset)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))""",
    re.I,
)
MODULE_SCRIPT_RE = re.compile(
    r"""<script\b[^>]*\btype\s*=\s*["']?module["']?[^>]*>""",
    re.I,
)
MODULE_PRELOAD_RE = re.compile(
    r"""<link\b[^>]*\brel\s*=\s*["']?modulepreload["']?[^>]*>""",
    re.I,
)
DOC_TAG_RE = re.compile(r"<(a|area|iframe|frame)\b[^>]*>", re.I)
JS_LOCATION_RE = re.compile(
    r"""(?P<prefix>(?:window\.|document\.|top\.|parent\.|self\.)?location(?:\.(?:href|assign|replace))?\s*(?:=|\()\s*)(?P<q>["'])(?P<url>[^"']+)(?P=q)""",
    re.I,
)
STYLE_BLOCK_RE = re.compile(r"(<style\b[^>]*>)([\s\S]*?)(</style>)", re.I)
STYLE_ATTR_RE = re.compile(r"""(\sstyle\s*=\s*)("([^"]*)"|'([^']*)')""", re.I)
META_TAG_RE = re.compile(r"<meta\b[^>]*>", re.I)
META_REFRESH_CHECK_RE = re.compile(r"""http-equiv\s*=\s*["']?\s*refresh""", re.I)
META_CONTENT_RE = re.compile(r"""(content\s*=\s*)(["'])([^"']*)\2""", re.I)
REFRESH_URL_RE = re.compile(r"url\s*=\s*([^;]+)", re.I)
CSS_URL_RE = re.compile(r"""url\(\s*(['"]?)([^'")]+)\1\s*\)""", re.I)
CSS_IMPORT_RE = re.compile(r"""@import\s+(['"])([^'"]+)\1""", re.I)
BASE_TAG_RE = re.compile(r"<base\b[^>]*>", re.I)
HEAD_TAG_RE = re.compile(r"<head[^>]*>", re.I)
HTML_TAG_RE = re.compile(r"<html[^>]*>", re.I)
CHARSET_RE = re.compile(r"charset=([\w.-]+)", re.I)
IS_HTML_SNIFF_RE = re.compile(r"^\s*(?:<!doctype\s+html|<html[\s>]|<!--)", re.I)

SKIP_URL_RE = re.compile(
    r"^(?:#|data:|blob:|javascript:|mailto:|tel:|sms:|about:|chrome:|"
    r"chrome-extension:|moz-extension:|intent:|file:)",
    re.I,
)

SHIM_TEMPLATE = r"""
(function () {
  var T = __TARGET__;
  var P = __PROXY__;
  var HOSTMODE = __HOSTMODE__;
  var HOST = "";
  try { HOST = new URL(T).hostname.toLowerCase(); } catch (e) {}
  var SEARCH_POST = /(^|\.)duckduckgo\.com$/i;
  var ENC = function (value) {
    try {
      var bytes = new TextEncoder().encode(value);
      var binary = "";
      for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    } catch (e) { return ""; }
  };
  var DEC = function (value) {
    try {
      var t = String(value).replace(/-/g, "+").replace(/_/g, "/");
      t += "=".repeat((4 - t.length % 4) % 4);
      var bin = atob(t);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    } catch (e) { return ""; }
  };
  var DOC = "";
  try { DOC = new URL(location.href).searchParams.get("__proxy") || ""; } catch (e) {}
  var DOC_ORIGIN = DOC ? DEC(DOC) : "";

  var currentTarget = function () {
    try {
      if (DOC) {
        var u = new URL(location.href);
        var q = new URLSearchParams(u.search);
        q.delete("__proxy");
        var qs = q.toString();
        return DOC_ORIGIN.replace(/\/+$/, "") + (u.pathname || "/") + (qs ? "?" + qs : "") + u.hash;
      }
      if (HOSTMODE) {
        var host = location.hostname.toLowerCase();
        if (host.length >= 10 && host.slice(-10) === ".localhost") {
          var proto = "https:";
          try { proto = new URL(T).protocol; } catch (e) {}
          return proto + "//" + host.slice(0, -10) + location.pathname + location.search + location.hash;
        }
      }
      var raw = new URL(location.href).searchParams.get("u");
      if (raw) {
        var decoded = DEC(raw);
        if (decoded) return decoded;
      }
    } catch (e) {}
    return T;
  };

  var PROX = function (value) {
    if (!value) return value;
    var text = String(value);
    if (/^(?:#|data:|blob:|javascript:|mailto:|tel:|sms:|about:|chrome:|chrome-extension:|moz-extension:)/i.test(text)) return value;
    try {
      var url = new URL(text, currentTarget());
      try {
        var dhost = url.hostname.toLowerCase();
        if ((dhost === "duckduckgo.com" || dhost.slice(-15) === ".duckduckgo.com") &&
            (url.pathname === "/l" || url.pathname === "/l/") && url.searchParams.has("uddg")) {
          url = new URL(url.searchParams.get("uddg"));
        }
      } catch (e) {}
      if (url.protocol !== "http:" && url.protocol !== "https:") return value;
      if (url.origin === location.origin && url.searchParams.has("__proxy")) return url.href;
      if (HOSTMODE) {
        var host = url.hostname.toLowerCase();
        if (host.length >= 10 && host.slice(-10) === ".localhost") return url.href;
        var port = location.port ? ":" + location.port : "";
        return location.protocol + "//" + host + ".localhost" + port + url.pathname + url.search + url.hash;
      }
      if (text.indexOf(P + "?u=") === 0) return value;
      var proxyPath = "";
      try { proxyPath = new URL(P).pathname; } catch (e) {}
      if (proxyPath && text.charAt(0) === "/" && text.indexOf(proxyPath + "?u=") === 0) return value;
      if (proxyPath && url.pathname === proxyPath && url.searchParams.has("u")) return P + url.search;
      if (url.origin === location.origin && url.pathname === new URL(P).pathname) return value;
      return P + "?u=" + ENC(url.href);
    } catch (e) { return value; }
  };

  var NAV = function (value) {
    if (!value) return value;
    var text = String(value);
    if (/^(?:#|data:|blob:|javascript:|mailto:|tel:|sms:|about:|chrome:|chrome-extension:|moz-extension:)/i.test(text)) return value;
    try {
      var url = new URL(text, currentTarget());
      try {
        var dhost = url.hostname.toLowerCase();
        if ((dhost === "duckduckgo.com" || dhost.slice(-15) === ".duckduckgo.com") &&
            (url.pathname === "/l" || url.pathname === "/l/") && url.searchParams.has("uddg")) {
          url = new URL(url.searchParams.get("uddg"));
        }
      } catch (e) {}
      if (url.protocol !== "http:" && url.protocol !== "https:") return value;
      if (url.origin === location.origin) {
        if (url.searchParams.has("__proxy")) return url.href;
        if (url.pathname === "/p" && url.searchParams.has("u")) return url.href;
        if (url.pathname.indexOf("/p/") === 0) return url.href;
      }
      if (HOSTMODE) {
        var host = url.hostname.toLowerCase();
        if (host.length >= 10 && host.slice(-10) === ".localhost") return url.href;
        var port = location.port ? ":" + location.port : "";
        return location.protocol + "//" + host + ".localhost" + port + url.pathname + url.search + url.hash;
      }
      if (DOC) {
        var targetOrigin = url.protocol + "//" + url.host;
        var q = url.search ? url.search.slice(1) : "";
        return (
          location.origin + (url.pathname || "/") +
          (q ? "?" + q : "") +
          (q ? "&" : "?") + "__proxy=" + ENC(targetOrigin) + url.hash
        );
      }
      return PROX(url.href);
    } catch (e) { return value; }
  };

  var report = function () {
    try { parent.postMessage({ __arcadeProxy: true, url: currentTarget() }, "*"); } catch (e) {}
  };
  report();

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

  try {
    var nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      args[1] = PROX(url);
      return nativeOpen.apply(this, args);
    };
  } catch (e) {}

  try {
    var nativeSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      var key = String(name).toLowerCase();
      if (key === "src" || key === "href" || key === "poster" || key === "data" || key === "srcset" || key === "action") {
        try {
          if (key === "srcset") {
            value = String(value).split(",").map(function (part) {
              var bits = part.trim().split(/\s+/);
              if (bits[0]) bits[0] = PROX(bits[0]);
              return bits.join(" ");
            }).join(", ");
          } else {
            var tag = String(this.tagName || "").toUpperCase();
            var isDoc =
              (key === "href" && (tag === "A" || tag === "AREA")) ||
              (key === "src" && (tag === "IFRAME" || tag === "FRAME")) ||
              (key === "action" && tag === "FORM");
            value = isDoc ? NAV(value) : PROX(value);
          }
        } catch (e) {}
      }
      return nativeSetAttribute.call(this, name, value);
    };
  } catch (e) {}

  function patchSrc(proto, prop, fn) {
    try {
      var desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (!desc || !desc.set) return;
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set: function (value) { return desc.set.call(this, fn(value)); }
      });
    } catch (e) {}
  }
  try { patchSrc(HTMLImageElement.prototype, "src", PROX); } catch (e) {}
  try { patchSrc(HTMLScriptElement.prototype, "src", PROX); } catch (e) {}
  try { patchSrc(HTMLIFrameElement.prototype, "src", NAV); } catch (e) {}
  try { patchSrc(HTMLMediaElement.prototype, "src", PROX); } catch (e) {}
  try { patchSrc(HTMLSourceElement.prototype, "src", PROX); } catch (e) {}
  try { patchSrc(HTMLSourceElement.prototype, "srcset", PROX); } catch (e) {}
  try { patchSrc(HTMLLinkElement.prototype, "href", PROX); } catch (e) {}
  try { patchSrc(HTMLAnchorElement.prototype, "href", NAV); } catch (e) {}
  try { patchSrc(HTMLFormElement.prototype, "action", NAV); } catch (e) {}

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
        var action = new URL(form.getAttribute("action") || currentTarget(), currentTarget());
        new FormData(form).forEach(function (value, key) {
          if (typeof value === "string") action.searchParams.append(key, value);
        });
        location.href = NAV(action.href);
      } catch (e) {}
    }, true);
  } catch (e) {}

  try {
    var nativeOpenWindow = window.open;
    window.open = function (url) {
      var args = Array.prototype.slice.call(arguments);
      if (url) args[0] = NAV(url);
      return nativeOpenWindow.apply(window, args);
    };
  } catch (e) {}

  try {
    var patchHistory = function (name) {
      var original = history[name];
      if (!original) return;
      history[name] = function (state, title, url) {
        var result;
        if (url) {
          try { url = NAV(new URL(url, currentTarget()).href); } catch (e) {}
        }
        result = original.call(history, state, title, url);
        try { report(); } catch (e) {}
        return result;
      };
    };
    patchHistory("pushState");
    patchHistory("replaceState");
    window.addEventListener("popstate", report);
    window.addEventListener("hashchange", report);
  } catch (e) {}

  /* Best effort: some sites redirect with location.replace/assign/href from an
     inline script. Location members are unforgeable in most browsers, so this
     usually throws and is caught; the server also rewrites inline redirects. */
  try {
    var locProto = Location.prototype;
    ["assign", "replace"].forEach(function (name) {
      var original = locProto[name];
      if (typeof original !== "function") return;
      try {
        Object.defineProperty(locProto, name, {
          configurable: true,
          value: function (url) { return original.call(this, NAV(url)); }
        });
      } catch (e) {}
    });
    var hrefDesc = Object.getOwnPropertyDescriptor(locProto, "href");
    if (hrefDesc && hrefDesc.set) {
      try {
        Object.defineProperty(locProto, "href", {
          configurable: true,
          get: hrefDesc.get,
          set: function (value) { return hrefDesc.set.call(this, NAV(value)); }
        });
      } catch (e) {}
    }
  } catch (e) {}
})();
"""


# ---------------------------------------------------------------------------
# URL helpers
# ---------------------------------------------------------------------------

def encode_token(value: str) -> str:
    return base64.urlsafe_b64encode(value.encode("utf-8")).decode("ascii").rstrip("=")


def decode_token(value: str) -> str | None:
    try:
        padded = value + "=" * ((4 - len(value) % 4) % 4)
        return base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
    except Exception:
        return None


def _origin_host(origin: str) -> str:
    try:
        return (urllib.parse.urlsplit(origin).hostname or "").lower()
    except Exception:
        return ""


def _is_host_mode(origin: str) -> bool:
    host = _origin_host(origin)
    return host.endswith(".localhost") and host != "localhost"


def proxy_href(target: str, origin: str) -> str:
    if _is_host_mode(origin):
        try:
            t = urllib.parse.urlsplit(target)
            o = urllib.parse.urlsplit(origin)
        except Exception:
            return target
        if t.scheme not in ("http", "https") or not t.hostname:
            return target
        host = t.hostname.lower()
        if host.endswith(".localhost"):
            return target
        if ":" in host:
            return origin.rstrip("/") + "/p?u=" + encode_token(target)
        local = (
            (o.scheme or "http")
            + "://"
            + host
            + ".localhost"
            + ((":" + str(o.port)) if o.port else "")
        )
        path = t.path or "/"
        if not path.startswith("/"):
            path = "/" + path
        return (
            local
            + path
            + (("?" + t.query) if t.query else "")
            + (("#" + t.fragment) if t.fragment else "")
        )
    return origin.rstrip("/") + "/p?u=" + encode_token(target)


def proxy_doc_href(target: str, page_url: str, origin: str) -> str:
    """Document URL that keeps the site's real pathname on the local origin.

    Assets still use /p?u=; only navigations need this so client-side routers
    (React Router and friends) see /some/path instead of /p.
    """
    value = (target or "").strip()
    if not value or SKIP_URL_RE.match(value):
        return target
    try:
        absolute = urllib.parse.urljoin(page_url, value)
        parts = urllib.parse.urlsplit(absolute)
    except Exception:
        return target
    if parts.scheme not in ("http", "https"):
        return target
    # Unwrap DuckDuckGo's /l/?uddg=<target> result redirects so the browser
    # goes straight to the destination instead of the interstitial page.
    try:
        if (parts.hostname or "").lower().endswith("duckduckgo.com") and parts.path.rstrip("/") == "/l":
            uddg = urllib.parse.parse_qs(parts.query).get("uddg", [""])[0]
            dest = urllib.parse.urlsplit(uddg)
            if dest.scheme in ("http", "https") and dest.netloc:
                absolute = urllib.parse.urlunsplit(dest)
                parts = dest
    except Exception:
        pass
    # Unwrap Bing's /ck/a click-tracking redirects (u=a1<base64url target>).
    try:
        if (parts.hostname or "").lower().endswith("bing.com") and parts.path.rstrip("/") == "/ck/a":
            raw = urllib.parse.parse_qs(parts.query).get("u", [""])[0]
            if raw.startswith("a1"):
                raw = raw[2:]
            pad = "=" * (-len(raw) % 4)
            decoded = base64.urlsafe_b64decode(raw + pad).decode("utf-8", "replace")
            dest = urllib.parse.urlsplit(decoded)
            if dest.scheme in ("http", "https") and dest.netloc:
                absolute = urllib.parse.urlunsplit(dest)
                parts = dest
    except Exception:
        pass
    if "__proxy=" in absolute:
        return value
    if absolute.startswith(origin.rstrip("/") + "/p?") or absolute.startswith(origin.rstrip("/") + "/p/"):
        return value
    if _is_host_mode(origin):
        return proxy_href(absolute, origin)
    host = _origin_host(origin)
    if host not in ("localhost", "127.0.0.1", "::1"):
        return proxy_href(absolute, origin)

    doc_origin = parts.scheme + "://" + parts.netloc
    token = encode_token(doc_origin)
    path = parts.path or "/"
    query = parts.query
    out = origin.rstrip("/") + path
    if query:
        out += "?" + query
    out += ("&" if query else "?") + "__proxy=" + token
    if parts.fragment:
        out += "#" + parts.fragment
    return out


def proxy_module_href(target: str, origin: str) -> str:
    """Path-preserving URL for ES modules so relative imports keep working."""
    if _is_host_mode(origin):
        # The host-based route already preserves the site's real path, so
        # relative imports resolve naturally.
        return proxy_href(target, origin)
    parts = urllib.parse.urlsplit(target)
    path = parts.path or "/"
    directory, _, name = path.rpartition("/")
    directory = (directory or "") + "/"
    if not name:
        name = "index"
    base = urllib.parse.urlunsplit((parts.scheme, parts.netloc, directory, "", ""))
    url = (
        origin.rstrip("/")
        + "/p/"
        + encode_token(base)
        + "/"
        + urllib.parse.quote(name, safe="!$&'()*+,;=:@%~-._")
    )
    if parts.query:
        url += "?" + parts.query
    return url


def rewrite_url(raw: str, page_url: str, origin: str) -> str:
    value = (raw or "").strip()
    if not value or SKIP_URL_RE.match(value):
        return raw

    try:
        absolute = urllib.parse.urljoin(page_url, value)
        parts = urllib.parse.urlsplit(absolute)
    except Exception:
        return raw

    if parts.scheme not in ("http", "https"):
        return raw

    # Already proxied? (host-based local origins, __proxy docs, and /p routes)
    if (parts.hostname or "").lower().endswith(".localhost"):
        return value
    if "__proxy=" in absolute and absolute.startswith(origin.rstrip("/") + "/"):
        return value
    if absolute.startswith(origin.rstrip("/") + "/p?"):
        return value
    if absolute.startswith(origin.rstrip("/") + "/p/"):
        return value

    return proxy_href(absolute, origin)


def rewrite_srcset(value: str, page_url: str, origin: str) -> str:
    out = []
    for part in value.split(","):
        bits = part.strip().split()
        if not bits:
            out.append(part)
            continue
        bits[0] = rewrite_url(bits[0], page_url, origin)
        out.append(" ".join(bits))
    return ", ".join(out)


def rewrite_refresh_content(content: str, page_url: str, origin: str) -> str:
    def repl(match: re.Match) -> str:
        clean = match.group(1).strip().strip("'\"")
        return "url=" + proxy_doc_href(clean, page_url, origin)

    return REFRESH_URL_RE.sub(repl, content)


def rewrite_css(css: str, page_url: str, origin: str) -> str:
    def url_repl(match: re.Match) -> str:
        quote, url = match.group(1), match.group(2)
        new = rewrite_url(url, page_url, origin)
        if new == url:
            return match.group(0)
        return "url(" + quote + new + quote + ")"

    def import_repl(match: re.Match) -> str:
        quote, url = match.group(1), match.group(2)
        new = rewrite_url(url, page_url, origin)
        if new == url:
            return match.group(0)
        return '@import "' + new + '"'

    css = CSS_URL_RE.sub(url_repl, css)
    return CSS_IMPORT_RE.sub(import_repl, css)


def _value_from_groups(match: re.Match, groups: tuple[int, int, int]) -> str:
    for index in groups:
        if match.group(index) is not None:
            return match.group(index)
    return ""


def rewrite_html(source: str, page_url: str, origin: str) -> str:
    output = source

    output = BASE_TAG_RE.sub("", output)

    def srcset_repl(match: re.Match) -> str:
        value = html.unescape(_value_from_groups(match, (4, 5, 6)))
        if re.search(r"data:", value, re.I):
            return match.group(0)
        new = rewrite_srcset(value, page_url, origin)
        return match.group(1) + match.group(2) + '="' + html.escape(new, quote=True) + '"'

    output = SRCSET_RE.sub(srcset_repl, output)

    def module_tag_repl(match: re.Match) -> str:
        tag = match.group(0)

        def module_attr_repl(attr_match: re.Match) -> str:
            attr = attr_match.group(2).lower()
            if attr not in ("src", "href"):
                return attr_match.group(0)
            value = html.unescape(_value_from_groups(attr_match, (4, 5, 6)))
            absolute = urllib.parse.urljoin(page_url, value)
            if urllib.parse.urlsplit(absolute).scheme not in ("http", "https"):
                return attr_match.group(0)
            if absolute.startswith(origin.rstrip("/") + "/p"):
                return attr_match.group(0)
            new = proxy_module_href(absolute, origin)
            return attr_match.group(1) + attr_match.group(2) + '="' + html.escape(new, quote=True) + '"'

        return URL_ATTR_RE.sub(module_attr_repl, tag)

    output = MODULE_SCRIPT_RE.sub(module_tag_repl, output)
    output = MODULE_PRELOAD_RE.sub(module_tag_repl, output)

    def doc_tag_repl(match: re.Match) -> str:
        tag = match.group(0)
        attr_name = "src" if match.group(1).lower() in ("iframe", "frame") else "href"

        def doc_attr_repl(attr_match: re.Match) -> str:
            if attr_match.group(2).lower() != attr_name:
                return attr_match.group(0)
            value = html.unescape(_value_from_groups(attr_match, (4, 5, 6)))
            new = proxy_doc_href(value, page_url, origin)
            return attr_match.group(1) + attr_match.group(2) + '="' + html.escape(new, quote=True) + '"'

        return URL_ATTR_RE.sub(doc_attr_repl, tag)

    output = DOC_TAG_RE.sub(doc_tag_repl, output)

    def attr_repl(match: re.Match) -> str:
        value = html.unescape(_value_from_groups(match, (4, 5, 6)))
        new = rewrite_url(value, page_url, origin)
        return match.group(1) + match.group(2) + '="' + html.escape(new, quote=True) + '"'

    output = URL_ATTR_RE.sub(attr_repl, output)

    def style_block_repl(match: re.Match) -> str:
        return match.group(1) + rewrite_css(match.group(2), page_url, origin) + match.group(3)

    output = STYLE_BLOCK_RE.sub(style_block_repl, output)

    def style_attr_repl(match: re.Match) -> str:
        value = match.group(3) if match.group(3) is not None else (match.group(4) or "")
        new = rewrite_css(html.unescape(value), page_url, origin)
        return match.group(1) + '"' + html.escape(new, quote=True) + '"'

    output = STYLE_ATTR_RE.sub(style_attr_repl, output)

    def meta_repl(match: re.Match) -> str:
        tag = match.group(0)
        if not META_REFRESH_CHECK_RE.search(tag):
            return tag

        def content_repl(content_match: re.Match) -> str:
            prefix, quote, content = content_match.group(1), content_match.group(2), content_match.group(3)
            new_content = rewrite_refresh_content(html.unescape(content), page_url, origin)
            return prefix + quote + html.escape(new_content, quote=True) + quote

        return META_CONTENT_RE.sub(content_repl, tag, count=1)

    output = META_TAG_RE.sub(meta_repl, output)

    def js_location_repl(match: re.Match) -> str:
        url_value = match.group("url")
        new = proxy_doc_href(url_value, page_url, origin)
        if new == url_value:
            return match.group(0)
        return match.group("prefix") + match.group("q") + new + match.group("q")

    output = JS_LOCATION_RE.sub(js_location_repl, output)

    return inject_shim(output, page_url, origin)


def inject_shim(document: str, page_url: str, origin: str) -> str:
    shim = "<script>" + build_shim(page_url, origin) + "</script>"
    head = HEAD_TAG_RE.search(document)
    if head:
        return document[: head.end()] + shim + document[head.end():]
    html_tag = HTML_TAG_RE.search(document)
    if html_tag:
        return document[: html_tag.end()] + shim + document[html_tag.end():]
    return shim + document


def build_shim(page_url: str, origin: str) -> str:
    return (
        SHIM_TEMPLATE.replace("__TARGET__", json.dumps(page_url))
        .replace("__PROXY__", json.dumps(origin.rstrip("/") + "/p"))
        .replace("__HOSTMODE__", "true" if _is_host_mode(origin) else "false")
        .replace("</script>", "<\\/script>")
    )


# ---------------------------------------------------------------------------
# SSRF guard
# ---------------------------------------------------------------------------

_dns_cache: dict[str, tuple[bool, float]] = {}
_dns_lock = threading.Lock()
DNS_TTL_SECONDS = 300.0


def _host_resolves_private(host: str) -> bool:
    now = time.monotonic()
    with _dns_lock:
        cached = _dns_cache.get(host)
        if cached and now - cached[1] < DNS_TTL_SECONDS:
            return cached[0]

    blocked = False
    try:
        for info in socket.getaddrinfo(host, None):
            try:
                ip = ipaddress.ip_address(info[4][0])
            except ValueError:
                continue
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
                blocked = True
                break
    except OSError:
        pass

    with _dns_lock:
        if len(_dns_cache) > 1024:
            _dns_cache.clear()
        _dns_cache[host] = (blocked, now)
    return blocked


def is_blocked_host(hostname: str) -> bool:
    host = (hostname or "").lower().strip("[]")
    if not host:
        return True
    if host in {"localhost", "::1", "0.0.0.0"}:
        return True
    if host.endswith((".local", ".internal", ".lan", ".localhost")):
        return True

    try:
        ip = ipaddress.ip_address(host)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            return True
        if ip in ipaddress.ip_network("100.64.0.0/10"):
            return True
    except ValueError:
        pass

    # Resolve the name (cached) and block anything that points somewhere private.
    return _host_resolves_private(host)


# ---------------------------------------------------------------------------
# Upstream fetching
# ---------------------------------------------------------------------------

class Upstream:
    def __init__(self, status, headers, url, body):
        self.status = status
        self.headers = headers
        self.url = url
        self.body = body


_SSL_CONTEXT = ssl.create_default_context()
_pool_lock = threading.Lock()
_pool: dict[tuple[str, str, int], list[tuple[object, float]]] = {}
POOL_IDLE_SECONDS = 25.0
MAX_IDLE_PER_HOST = 8


def _new_connection(scheme: str, host: str, port: int):
    if scheme == "https":
        conn = http.client.HTTPSConnection(host, port, timeout=20, context=_SSL_CONTEXT)
    else:
        conn = http.client.HTTPConnection(host, port, timeout=20)
    conn.connect()
    if conn.sock is not None:
        try:
            conn.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass
    return conn


def _connection_for(scheme: str, host: str, port: int):
    key = (scheme, host, port)
    now = time.monotonic()
    while True:
        with _pool_lock:
            entries = _pool.get(key)
            if not entries:
                break
            conn, last_used = entries.pop()
        if now - last_used < POOL_IDLE_SECONDS and conn.sock is not None:
            return conn, True
        try:
            conn.close()
        except Exception:
            pass
    return _new_connection(scheme, host, port), False


def _clear_pool_key(key) -> None:
    with _pool_lock:
        entries = _pool.pop(key, [])
    for conn, _ in entries:
        try:
            conn.close()
        except Exception:
            pass


def _release_connection(scheme: str, host: str, port: int, conn, reusable: bool) -> None:
    if not reusable:
        try:
            conn.close()
        except Exception:
            pass
        return

    key = (scheme, host, port)
    with _pool_lock:
        entries = _pool.setdefault(key, [])
        if len(entries) < MAX_IDLE_PER_HOST:
            entries.append((conn, time.monotonic()))
            return
    try:
        conn.close()
    except Exception:
        pass


def _prewarm(target: str, count: int = 3) -> None:
    """Open a few upstream connections while the page is being rewritten."""
    try:
        parts = urllib.parse.urlsplit(target)
        scheme = parts.scheme.lower()
        host = (parts.hostname or "").encode("idna").decode("ascii")
        port = parts.port or (443 if scheme == "https" else 80)
    except Exception:
        return

    key = (scheme, host, port)
    with _pool_lock:
        have = len(_pool.get(key, []))
    for _ in range(max(0, count - have)):
        try:
            conn = _new_connection(scheme, host, port)
        except Exception:
            return
        _release_connection(scheme, host, port, conn, True)


def _prewarm_async(target: str, count: int = 3) -> None:
    threading.Thread(target=_prewarm, args=(target, count), daemon=True).start()


# Small in-memory cache for static assets. The browser cache still does most
# of the work; this mainly helps reloads and assets shared between pages.
_asset_cache: dict[str, tuple[float, int, str, bytes, dict]] = {}
_asset_cache_lock = threading.Lock()
_asset_cache_bytes = 0
ASSET_CACHE_TTL = 300.0
ASSET_CACHE_MAX_BYTES = 24 * 1024 * 1024
ASSET_CACHE_MAX_ENTRY = 2 * 1024 * 1024


def _cache_get(key: str):
    global _asset_cache_bytes
    now = time.monotonic()
    with _asset_cache_lock:
        entry = _asset_cache.get(key)
        if not entry:
            return None
        if entry[0] > now:
            return entry[1:]
        _asset_cache.pop(key, None)
        _asset_cache_bytes -= len(entry[3])
    return None


def _cache_put(key: str, status: int, content_type: str, body: bytes, headers: dict) -> None:
    global _asset_cache_bytes
    if status != 200 or len(body) > ASSET_CACHE_MAX_ENTRY:
        return
    with _asset_cache_lock:
        old = _asset_cache.get(key)
        if old:
            _asset_cache_bytes -= len(old[3])
        _asset_cache[key] = (
            time.monotonic() + ASSET_CACHE_TTL,
            status,
            content_type,
            body,
            dict(headers),
        )
        _asset_cache_bytes += len(body)
        while _asset_cache_bytes > ASSET_CACHE_MAX_BYTES and _asset_cache:
            oldest_key, oldest = next(iter(_asset_cache.items()))
            _asset_cache.pop(oldest_key, None)
            _asset_cache_bytes -= len(oldest[3])


def _proxy_referer(value: str | None) -> str | None:
    """Turn a /p... referer back into the real page/asset URL."""
    if not value:
        return None
    try:
        parts = urllib.parse.urlsplit(value)
    except ValueError:
        return None
    query = urllib.parse.parse_qs(parts.query, keep_blank_values=True)
    if "__proxy" in query:
        base = decode_token(query["__proxy"][0])
        if not base:
            return None
        try:
            base_parts = urllib.parse.urlsplit(base)
        except ValueError:
            return None
        if base_parts.scheme not in ("http", "https") or not base_parts.netloc:
            return None
        target = base_parts.scheme + "://" + base_parts.netloc + (parts.path or "/")
        rest = [(key, val) for key, val in query.items() if key != "__proxy"]
        if rest:
            target += "?" + urllib.parse.urlencode(rest, doseq=True)
        return target

    if parts.path != "/p" and parts.path != "/p/" and not parts.path.startswith("/p/"):
        host = (parts.hostname or "").lower()
        if host.endswith(".localhost") and host != "localhost":
            target_host = host[: -len(".localhost")]
            if not target_host:
                return None
            target = "https://" + target_host + (parts.path or "/")
            if parts.query:
                target += "?" + parts.query
            return target
        return None

    target = None
    if parts.path.startswith("/p/"):
        rest = parts.path[3:]
        if "/" in rest:
            head, _, sub = rest.partition("/")
            base = decode_token(head)
            if base:
                target = urllib.parse.urljoin(base, sub) if sub else base
        else:
            target = decode_token(rest)
    if target is None:
        token = urllib.parse.parse_qs(parts.query).get("u", [""])[0]
        target = decode_token(token) if token else None
    if not target:
        return None
    try:
        if urllib.parse.urlsplit(target).scheme not in ("http", "https"):
            return None
    except ValueError:
        return None
    return target


def fetch_upstream(target: str, method: str, client_headers, body: bytes | None) -> Upstream:
    parts = urllib.parse.urlsplit(target)
    scheme = parts.scheme.lower()
    host = parts.hostname or ""
    try:
        port = parts.port or (443 if scheme == "https" else 80)
    except ValueError as error:
        raise RuntimeError("Invalid port") from error

    try:
        ascii_host = host.encode("idna").decode("ascii")
    except UnicodeError:
        ascii_host = host

    path = urllib.parse.quote(
        urllib.parse.urlunsplit(("", "", parts.path or "/", parts.query, "")),
        safe="/%?&=#:+,;@!$'()*[]~-._",
    )

    headers = {
        "User-Agent": USER_AGENT,
        "Accept": client_headers.get("Accept") or "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip",
    }
    if body is not None and client_headers.get("Content-Type"):
        headers["Content-Type"] = client_headers.get("Content-Type")

    # Send the real page URL as Referer (not the arcade's /p address). Many
    # sites, including DuckDuckGo's result redirects, require it.
    referer = _proxy_referer(client_headers.get("Referer"))
    if referer:
        headers["Referer"] = referer
    for name in ("If-None-Match", "If-Modified-Since"):
        value = client_headers.get(name)
        if value:
            headers[name] = value

    def attempt(conn):
        conn.request(method, path, body=body, headers=headers)
        response = conn.getresponse()
        raw = b"" if method == "HEAD" else response.read()
        return response, raw

    conn, reused = _connection_for(scheme, ascii_host, port)
    try:
        try:
            response, raw = attempt(conn)
        except (http.client.HTTPException, OSError):
            if not reused or method not in ("GET", "HEAD"):
                raise
            # The upstream may have closed an idle keep-alive connection.
            try:
                conn.close()
            except Exception:
                pass
            _clear_pool_key((scheme, ascii_host, port))
            conn, _ = _connection_for(scheme, ascii_host, port)
            response, raw = attempt(conn)
    except Exception as error:
        try:
            conn.close()
        except Exception:
            pass
        _clear_pool_key((scheme, ascii_host, port))
        raise RuntimeError(str(error)) from error

    status = getattr(response, "status", 0) or 0
    response_headers = {key.lower(): value for key, value in response.getheaders()}
    _release_connection(scheme, ascii_host, port, conn, not response.will_close)

    encoding = (response_headers.get("content-encoding") or "").lower()
    if "gzip" in encoding:
        try:
            raw = gzip.decompress(raw)
        except OSError:
            pass
    elif "deflate" in encoding:
        try:
            raw = zlib.decompress(raw)
        except zlib.error:
            try:
                raw = zlib.decompress(raw, -zlib.MAX_WBITS)
            except zlib.error:
                pass

    return Upstream(status, response_headers, target, raw)


def decode_text(data: bytes, content_type: str) -> str:
    match = CHARSET_RE.search(content_type or "")
    if match:
        try:
            return data.decode(match.group(1), "replace")
        except LookupError:
            pass
    return data.decode("utf-8", "replace")


# ---------------------------------------------------------------------------
# HTML for notices
# ---------------------------------------------------------------------------

def page_shell(title: str, body: str) -> bytes:
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)} — Proxy</title>
<style>
  :root {{ color-scheme: dark; }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    background: radial-gradient(circle at 50% 0%, #14203a, #05070f 60%);
    color: #e8eef9; font-family: "Segoe UI", system-ui, sans-serif; }}
  .card {{ width: min(560px, 100%); padding: 28px; border: 1px solid rgba(148,163,184,.18);
    border-radius: 18px; background: rgba(11,18,32,.9); box-shadow: 0 30px 80px rgba(0,0,0,.5); }}
  h1 {{ margin: 0 0 8px; font-size: 22px; letter-spacing: -.02em; }}
  p {{ margin: 0 0 16px; color: #8d9db6; font-size: 14px; line-height: 1.6; }}
  form {{ display: flex; gap: 8px; }}
  input {{ flex: 1; min-width: 0; height: 44px; padding: 0 12px; border: 1px solid rgba(148,163,184,.22);
    border-radius: 10px; outline: 0; background: rgba(255,255,255,.04); color: #e8eef9; font: inherit; }}
  input:focus {{ border-color: rgba(34,211,238,.5); }}
  button {{ height: 44px; padding: 0 18px; border: 0; border-radius: 10px; cursor: pointer;
    background: linear-gradient(115deg,#22d3ee,#8b5cf6); color: #05070f; font-weight: 800; }}
  code {{ padding: 1px 5px; border-radius: 4px; background: rgba(255,255,255,.06); font-size: 12px; }}
  .foot {{ margin: 16px 0 0; font-size: 11.5px; color: #66768e; }}
  a {{ color: #a5f3fc; }}
</style></head>
<body><div class="card">{body}</div></body></html>""".encode("utf-8")


def info_page(origin: str) -> bytes:
    body = f"""
    <h1>Proxy endpoint</h1>
    <p>This is the local Ant Arcade proxy. Enter a URL to browse it here.</p>
    <form id="f">
      <input id="u" type="text" placeholder="example.com" autocomplete="off" spellcheck="false" autofocus>
      <button type="submit">Open</button>
    </form>
    <p class="foot">Link format: <code>/p?u=&lt;base64url&gt;</code>.
    Cookies and logins are not forwarded, so some sites will not work.</p>
    <p><a href="/">Back to the arcade</a></p>
    <script>
      document.getElementById("f").addEventListener("submit", function (event) {{
        event.preventDefault();
        var raw = document.getElementById("u").value.trim();
        if (!raw) return;
        if (!/^https?:\\/\\//i.test(raw)) raw = "https://" + raw;
        var bytes = new TextEncoder().encode(raw);
        var binary = "";
        for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        var token = btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
        location.href = {json.dumps(origin.rstrip("/") + "/p")} + "?u=" + token;
      }});
    </script>"""
    return page_shell("Proxy", body)


def error_page(status: int, message: str) -> bytes:
    body = f"""
    <h1>{html.escape(message)}</h1>
    <p>Try another URL, or go back to the arcade.</p>
    <p><a href="/">Back to the arcade</a></p>"""
    return page_shell("Proxy error", body)


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class ArcadeHandler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".json": "application/json",
        ".webmanifest": "application/manifest+json",
        ".wasm": "application/wasm",
        ".ico": "image/x-icon",
        ".ogg": "audio/ogg",
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))

    def end_headers(self):
        # python -m http.server sends no Cache-Control, so Chrome caches game
        # files heuristically and keeps running stale JS after an edit.
        if not getattr(self, "_proxy_mode", False):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def handle_one_request(self):
        self._proxy_mode = False
        super().handle_one_request()

    # -- routing ----------------------------------------------------------

    def _is_proxy_path(self, path: str) -> bool:
        return path == "/p" or path == "/p/" or path.startswith("/p/")

    def _host_proxy_target(self):
        host_header = self.headers.get("Host") or ""
        try:
            host = (urllib.parse.urlsplit("//" + host_header).hostname or "").lower().rstrip(".")
        except Exception:
            return None
        suffix = ".localhost"
        if host.endswith(suffix) and host != "localhost":
            target_host = host[: -len(suffix)]
            # Require a dotted name so the plain arcade host and accidental
            # single-label hosts are not mistaken for proxied sites.
            if target_host and "." in target_host:
                return target_host
        return None

    def _has_doc_proxy(self) -> bool:
        try:
            query = urllib.parse.parse_qs(
                urllib.parse.urlsplit(self.path).query, keep_blank_values=True
            )
        except Exception:
            return False
        return "__proxy" in query

    def send_head(self):
        # ES modules loaded through the path-preserving proxy route still
        # resolve some specifiers to the local origin (for example an absolute
        # `import("/assets/chunk.js")`). When that happens the Referer tells us
        # which proxied site the request belongs to, so forward it upstream
        # instead of returning the arcade's own 404.
        parsed = urllib.parse.urlsplit(self.path)
        if (
            not self._is_proxy_path(parsed.path)
            and self.command in ("GET", "HEAD")
        ):
            referer_target = _proxy_referer(self.headers.get("Referer"))
            if referer_target:
                target = urllib.parse.urljoin(referer_target, parsed.path or "/")
                if parsed.query:
                    target += "?" + parsed.query
                self._fallback_target = target
                self.run_proxy(self.command)
                return None
        return super().send_head()

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if self._is_proxy_path(path) or self._has_doc_proxy() or self._host_proxy_target():
            self.run_proxy("GET")
        else:
            super().do_GET()

    def do_HEAD(self):
        path = urllib.parse.urlsplit(self.path).path
        if self._is_proxy_path(path) or self._has_doc_proxy() or self._host_proxy_target():
            self.run_proxy("HEAD")
        else:
            super().do_HEAD()

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        if self._is_proxy_path(path) or self._has_doc_proxy() or self._host_proxy_target():
            self.run_proxy("POST")
        else:
            self.send_error(405, "Method not allowed")

    def do_OPTIONS(self):
        self.send_response(204)
        self.add_cors()
        self.end_headers()

    # -- proxy ------------------------------------------------------------

    def run_proxy(self, method: str):
        self._proxy_mode = True
        parsed = urllib.parse.urlsplit(self.path)
        origin = "http://" + (self.headers.get("Host") or "127.0.0.1")

        target_raw = None
        fallback_mode = False
        doc_mode = False
        doc_origin = None
        host_target = None
        query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        if "__proxy" in query:
            token = query.get("__proxy", [""])[0]
            decoded = decode_token(token) if token else None
            try:
                doc_parts = urllib.parse.urlsplit(decoded or "")
            except Exception:
                doc_parts = None
            if (
                not decoded
                or doc_parts is None
                or doc_parts.scheme not in ("http", "https")
                or not doc_parts.netloc
            ):
                self.respond(400, "text/html; charset=utf-8", error_page(400, "That proxy link is malformed."), method)
                return
            doc_mode = True
            doc_origin = doc_parts.scheme + "://" + doc_parts.netloc
            target_raw = doc_origin.rstrip("/") + (parsed.path or "/")
            rest = [(key, val) for key, val in query.items() if key != "__proxy"]
            if rest:
                target_raw += "?" + urllib.parse.urlencode(rest, doseq=True)
        else:
            host_target = self._host_proxy_target()
            if host_target:
                # Host-based mode: duckmath.org.localhost:8090/ maps to
                # https://duckmath.org/. The browser's pathname then matches the
                # real site, which keeps SPA routers and relative imports happy.
                target_raw = "https://" + host_target + (parsed.path or "/")
                if parsed.query:
                    target_raw += "?" + parsed.query
            else:
                fallback = getattr(self, "_fallback_target", None)
                fallback_mode = bool(fallback)
                if fallback:
                    target_raw = fallback
                    self._fallback_target = None
                else:
                    token = urllib.parse.parse_qs(parsed.query).get("u", [""])[0]
                    if token:
                        target_raw = decode_token(token)
                    elif parsed.path.startswith("/p/"):
                        rest = parsed.path[3:]
                        if "/" in rest:
                            head, _, sub = rest.partition("/")
                            base = decode_token(head)
                            if base:
                                target_raw = urllib.parse.urljoin(base, sub) if sub else base
                                if parsed.query:
                                    target_raw += ("&" if "?" in target_raw else "?") + parsed.query
                        if target_raw is None:
                            target_raw = decode_token(rest)

        if not target_raw:
            if parsed.path in ("/p", "/p/") and not urllib.parse.parse_qs(parsed.query).get("u"):
                self.respond(200, "text/html; charset=utf-8", info_page(origin), method)
            else:
                self.respond(400, "text/html; charset=utf-8", error_page(400, "That proxy link is malformed."), method)
            return

        try:
            target = urllib.parse.urlsplit(target_raw)
        except Exception:
            self.respond(400, "text/html; charset=utf-8", error_page(400, "That proxy link is not a valid URL."), method)
            return

        if target.scheme not in ("http", "https"):
            self.respond(400, "text/html; charset=utf-8", error_page(400, "Only http and https URLs can be proxied."), method)
            return
        try:
            target_port = target.port
        except ValueError:
            target_port = -1
        if target_port not in (None, 80, 443):
            self.respond(403, "text/html; charset=utf-8", error_page(403, "Only standard web ports are allowed."), method)
            return
        if is_blocked_host(target.hostname or ""):
            self.respond(403, "text/html; charset=utf-8", error_page(403, "That host is blocked by the proxy."), method)
            return

        cache_key = origin + "|" + target_raw
        cacheable = method == "GET" and bool(STATIC_ASSET_RE.search(target.path or ""))
        if cacheable:
            cached = _cache_get(cache_key)
            if cached:
                self.respond(cached[0], cached[1], cached[2], method, cached[3])
                return

        body = None
        if method == "POST":
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            body = self.rfile.read(length) if length else b""

        try:
            upstream = fetch_upstream(target_raw, method, self.headers, body)
        except Exception:
            if host_target and target_raw.startswith("https://"):
                # Some sites are still HTTP-only; the host-based route defaults
                # to HTTPS, so retry cleartext before giving up.
                try:
                    upstream = fetch_upstream(
                        "http://" + target_raw[len("https://"):],
                        method,
                        self.headers,
                        body,
                    )
                except Exception:
                    self.respond(502, "text/html; charset=utf-8", error_page(502, "The site could not be reached."), method)
                    return
            else:
                self.respond(502, "text/html; charset=utf-8", error_page(502, "The site could not be reached."), method)
                return

        if upstream.status in (301, 302, 303, 307, 308):
            location = upstream.headers.get("location")
            if location:
                destination = urllib.parse.urljoin(upstream.url, location)
                if urllib.parse.urlsplit(destination).scheme in ("http", "https"):
                    # Keep redirects visible to the browser so the address bar
                    # ends up on the destination, like the production Worker.
                    location_url = (
                        proxy_doc_href(destination, upstream.url, origin)
                        if doc_mode
                        else proxy_href(destination, origin)
                    )
                    self.respond(
                        upstream.status,
                        "text/plain; charset=utf-8",
                        b"",
                        method,
                        {"location": location_url, "cache-control": "no-store"},
                    )
                    return

        content_type = (upstream.headers.get("content-type") or "").lower()
        is_html = "text/html" in content_type or "application/xhtml+xml" in content_type
        is_css = "text/css" in content_type

        if is_html and method == "GET":
            _prewarm_async(target_raw, 3)

        # Strip framing/login-hostile headers before we add ours.
        headers = {
            key: value
            for key, value in upstream.headers.items()
            if key.lower() not in STRIPPED_RESPONSE_HEADERS
        }
        headers.pop("content-length", None)
        headers.pop("content-encoding", None)

        refresh_header = upstream.headers.get("refresh")
        if refresh_header:
            headers["refresh"] = REFRESH_URL_RE.sub(
                lambda m: "url=" + proxy_doc_href(m.group(1).strip().strip("'\""), upstream.url, origin),
                refresh_header,
            )

        final_path = urllib.parse.urlsplit(upstream.url).path

        # A root-relative request from a proxied page (an absolute ES-module
        # import, a raw `location.href = "/"`, etc.) is served here as a
        # fallback. If it turns out to be a document, bounce it to the
        # path-preserving __proxy form so client-side routers keep working.
        if fallback_mode and method != "HEAD" and is_html:
            self.respond(
                302,
                "text/plain; charset=utf-8",
                b"",
                method,
                {"location": proxy_doc_href(upstream.url, upstream.url, origin), "cache-control": "no-store"},
            )
            return

        if method != "HEAD" and is_html:
            text = decode_text(upstream.body, content_type)
            payload = rewrite_html(text, upstream.url, origin).encode("utf-8")
            headers["content-type"] = "text/html; charset=utf-8"
            headers["cache-control"] = "no-store"
            self.respond(upstream.status, "text/html; charset=utf-8", payload, method, headers)
            return

        if method != "HEAD" and is_css:
            text = decode_text(upstream.body, content_type)
            payload = rewrite_css(text, upstream.url, origin).encode("utf-8")
            headers["cache-control"] = "private, max-age=300"
            _cache_put(cache_key, upstream.status, "text/css; charset=utf-8", payload, headers)
            self.respond(upstream.status, "text/css; charset=utf-8", payload, method, headers)
            return

        maybe_document = (
            method != "HEAD"
            and not STATIC_ASSET_RE.search(final_path)
            and (content_type.startswith("text/plain")
                 or content_type.startswith("application/octet-stream")
                 or content_type == "")
        )
        if maybe_document:
            try:
                text = upstream.body.decode("utf-8", "replace")
            except Exception:
                text = ""
            if IS_HTML_SNIFF_RE.match(text):
                payload = rewrite_html(text, upstream.url, origin).encode("utf-8")
                headers["content-type"] = "text/html; charset=utf-8"
                headers["cache-control"] = "no-store"
                self.respond(upstream.status, "text/html; charset=utf-8", payload, method, headers)
                return
            headers["content-type"] = upstream.headers.get("content-type") or "text/plain; charset=utf-8"
            headers["cache-control"] = "no-store"
            self.respond(upstream.status, headers["content-type"], upstream.body, method, headers)
            return

        if STATIC_ASSET_RE.search(final_path):
            headers["cache-control"] = "private, max-age=600"
            _cache_put(
                cache_key,
                upstream.status,
                upstream.headers.get("content-type") or "application/octet-stream",
                upstream.body,
                headers,
            )
        else:
            headers["cache-control"] = "no-store"

        self.respond(
            upstream.status,
            upstream.headers.get("content-type") or "application/octet-stream",
            upstream.body,
            method,
            headers,
        )

    def respond(self, status, content_type, body, method, extra_headers=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        extra_headers = dict(extra_headers or {})
        if (
            method != "HEAD"
            and status == 200
            and len(body) > 1400
            and "gzip" in (self.headers.get("Accept-Encoding") or "").lower()
            and "content-encoding" not in {key.lower() for key in extra_headers}
            and (
                content_type.startswith("text/")
                or content_type.startswith(("application/javascript", "application/json"))
                or content_type.startswith(("application/xml", "image/svg+xml", "application/xhtml+xml"))
            )
        ):
            body = gzip.compress(body, compresslevel=5, mtime=0)
            extra_headers["Content-Encoding"] = "gzip"
            extra_headers["Vary"] = "Accept-Encoding"

        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.add_cors()
        sent_cache_control = False
        for key, value in extra_headers.items():
            if key.lower() in {"content-type", "content-length", "access-control-allow-origin"}:
                continue
            if key.lower() == "cache-control":
                sent_cache_control = True
            self.send_header(key, value)
        if not sent_cache_control:
            self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if method != "HEAD":
            self.wfile.write(body)

    def add_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("X-Arcade-Proxy", "1")


class ThreadingServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    disable_nagle_algorithm = True


def main():
    parser = argparse.ArgumentParser(description="Ant Arcade local preview server (with /p proxy).")
    parser.add_argument("--port", type=int, default=8090, help="port to listen on (default: 8090)")
    parser.add_argument("--host", default="127.0.0.1", help="address to bind (default: 127.0.0.1)")
    parser.add_argument("--no-open", action="store_true", help="don't open a browser window")
    args = parser.parse_args()

    if not ROOT.is_dir():
        print(f"Could not find {ROOT}", file=sys.stderr)
        return 1

    server = None
    for candidate in range(args.port, args.port + 20):
        try:
            server = ThreadingServer((args.host, candidate), ArcadeHandler)
            break
        except OSError:
            continue

    if server is None:
        print(
            f"Could not bind {args.host}:{args.port}-{args.port + 19}. "
            "Close the program using that port, or pass --port.",
            file=sys.stderr,
        )
        return 1

    port = server.server_address[1]
    display_host = "localhost" if args.host in ("127.0.0.1", "0.0.0.0") else args.host
    url = f"http://{display_host}:{port}/"

    print()
    print("  Ant Arcade — local preview")
    print(f"  Site:  {url}")
    print(f"  Proxy: {url}p?u=<base64url>")
    print("  Press Ctrl+C to stop.")
    print()

    if not args.no_open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
