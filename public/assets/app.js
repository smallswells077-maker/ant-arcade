/* =========================================================
   Ant Arcade — app logic
   No frameworks, no build step.
   ========================================================= */
(function () {
  "use strict";

  /* ---------- config + data ---------- */

  var CONFIG = Object.assign(
    {
      siteName: "Ant Arcade",
      proxyBase: "p",
      panicUrl: "https://classroom.google.com/",
      defaultProxyGames: false,
    },
    window.ARCADE_CONFIG || {}
  );

  var GAMES = Array.isArray(window.ARCADE_GAMES) ? window.ARCADE_GAMES : [];

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var KEYS = {
    settings: "ant.settings.v1",
    favorites: "ant.favorites.v1",
    recents: "ant.recents.v1",
  };

  /* ---------- storage ---------- */

  var store = {
    get: function (key, fallback) {
      try {
        var raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) {
        return fallback;
      }
    },
    set: function (key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
    },
    remove: function (key) {
      try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
    },
  };

  var DEFAULT_SETTINGS = {
    cloakTitle: "",
    cloakIcon: "joystick",
    panicUrl: CONFIG.panicUrl || "https://classroom.google.com/",
    proxyBase: CONFIG.proxyBase || "p",
    proxyGames: !!CONFIG.defaultProxyGames,
    engine: "",
  };

  var settings = Object.assign({}, DEFAULT_SETTINGS, store.get(KEYS.settings, {}));
  var favorites = new Set(store.get(KEYS.favorites, []));
  var recents = Array.isArray(store.get(KEYS.recents, [])) ? store.get(KEYS.recents, []) : [];

  /* ---------- state ---------- */

  var state = {
    query: "",
    category: "All",
    favoritesOnly: false,
  };

  /* ---------- tiny helpers ---------- */

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(value) { return escapeHtml(value); }

  function toast(message) {
    var el = $("#toast");
    if (!el) return;
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { el.classList.remove("show"); }, 2400);
  }

  function setHash(hash) {
    try {
      history.replaceState(null, "", hash);
    } catch (e) {
      try { location.hash = hash; } catch (e2) { /* ignore */ }
    }
  }

  function absoluteUrl(url) {
    try { return new URL(url, location.href).href; } catch (e) { return url; }
  }

  function isHttp(url) {
    return /^https?:\/\//i.test(url);
  }

  /* ---------- base64url ---------- */

  function encodeTarget(value) {
    try {
      var bytes = new TextEncoder().encode(value);
      var binary = "";
      for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    } catch (e) {
      return "";
    }
  }

  function decodeTarget(value) {
    try {
      var b64 = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
      b64 += "=".repeat((4 - (b64.length % 4)) % 4);
      var binary = atob(b64);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    } catch (e) {
      return null;
    }
  }

  /* ---------- search engines ---------- */

  /*
   * Every entry needs `id`, `label`, `search` (query prefix) and `home`.
   * The first one is the default. Bing is first because DuckDuckGo blocks
   * datacenter IPs (the cloud proxy's IP); DDG still works from localhost.
   */
  var ENGINES = (Array.isArray(CONFIG.searchEngines) && CONFIG.searchEngines.length)
    ? CONFIG.searchEngines
    : [{
        id: "bing",
        label: "Bing",
        search: CONFIG.searchUrl || "https://www.bing.com/search?q=",
        home: CONFIG.proxyHome || "https://www.bing.com/",
      }];

  function selectedEngine() {
    var wanted = settings.engine;
    for (var i = 0; i < ENGINES.length; i++) {
      if (ENGINES[i].id === wanted) return ENGINES[i];
    }
    return ENGINES[0];
  }

  function searchUrlFor(query) {
    return selectedEngine().search + encodeURIComponent(query);
  }

  /* ---------- proxy URL helpers ---------- */

  function proxyBase() {
    var raw = String(settings.proxyBase == null ? "" : settings.proxyBase).trim() || "p";
    var url;
    try {
      url = new URL(raw, location.href);
    } catch (e) {
      url = new URL("p", location.href);
    }
    return url.href.replace(/\/+$/, "");
  }

  function localProxyBase() {
    var url;
    try {
      url = new URL(proxyBase());
    } catch (e) {
      return null;
    }
    var host = url.hostname.toLowerCase();
    if (host !== "localhost" && host !== "127.0.0.1") return null;
    if (url.pathname.replace(/\/+$/, "") !== "/p") return null;
    return url;
  }

  function proxyUrlFor(target) {
    /*
     * On the local preview server, serve documents at their real path
     * (e.g. localhost:8090/some/page?__proxy=...) instead of /p?u=... .
     * The pathname then matches the target site, so client-side routers
     * do not see a /p prefix and render a 404. Assets still use /p?u=.
     */
    var base = localProxyBase();
    if (base) {
      try {
        var t = new URL(target);
        if (
          (t.protocol === "http:" || t.protocol === "https:") &&
          !/[?&]__proxy=/.test(t.search)
        ) {
          var origin = t.protocol + "//" + t.host;
          var q = t.search ? t.search.slice(1) : "";
          return (
            base.origin + (t.pathname || "/") +
            (q ? "?" + q : "") +
            (q ? "&" : "?") + "__proxy=" + encodeTarget(origin) +
            t.hash
          );
        }
      } catch (e) {
        /* fall through to the /p?u= form */
      }
    }
    var url = new URL(proxyBase());
    url.searchParams.set("u", encodeTarget(target));
    return url.href;
  }

  function targetFromProxyUrl(href) {
    try {
      var url = new URL(href);
      var token = url.searchParams.get("__proxy");
      if (token) {
        var origin = decodeTarget(token);
        if (!origin || !isHttp(origin)) return null;
        var params = new URLSearchParams(url.search);
        params.delete("__proxy");
        var qs = params.toString();
        return origin.replace(/\/+$/, "") + (url.pathname || "/") + (qs ? "?" + qs : "") + url.hash;
      }
      var host = url.hostname.toLowerCase();
      if (host.length > 10 && host.slice(-10) === ".localhost") {
        return "https://" + host.slice(0, -10) + (url.pathname || "/") + url.search + url.hash;
      }
      if (!url.searchParams.has("u")) return null;
      var decoded = decodeTarget(url.searchParams.get("u"));
      return decoded && isHttp(decoded) ? decoded : null;
    } catch (e) {
      return null;
    }
  }

  var proxyProbe = { checked: false, ok: true, running: null };

  function proxyConfigured() {
    if (location.protocol === "file:") return false;
    return true;
  }

  function resetProxyProbe() {
    proxyProbe = { checked: false, ok: true, running: null };
  }

  function markProxyUnavailable() {
    proxyProbe.checked = true;
    proxyProbe.ok = false;
  }

  function showProxyNotice() {
    if (proxyNotice) proxyNotice.hidden = false;
    if (proxySpinner) proxySpinner.hidden = true;
  }

  /*
   * Static hosts (GitHub Pages, plain file servers) have no /p route, so a
   * quick HEAD tells us whether a proxy backend is actually reachable. The
   * answer is cached until the endpoint changes in Settings.
   */
  function testProxy() {
    if (proxyProbe.checked) return Promise.resolve(proxyProbe.ok);
    if (proxyProbe.running) return proxyProbe.running;
    if (location.protocol === "file:") {
      markProxyUnavailable();
      return Promise.resolve(false);
    }

    var probeUrl;
    try {
      probeUrl = proxyUrlFor("https://example.com/");
    } catch (e) {
      probeUrl = "";
    }
    if (!probeUrl) {
      markProxyUnavailable();
      return Promise.resolve(false);
    }

    proxyProbe.running = fetch(probeUrl, { method: "HEAD", mode: "cors", cache: "no-store" })
      .then(function (response) {
        // 405/501 mean "route exists, method not allowed", which is still a hit.
        return response.status < 400 || response.status === 405 || response.status === 501;
      })
      .catch(function () { return false; })
      .then(function (ok) {
        proxyProbe.checked = true;
        proxyProbe.ok = ok;
        proxyProbe.running = null;
        return ok;
      });
    return proxyProbe.running;
  }

  function normalizeInput(input) {
    var value = String(input || "").trim();
    if (!value) return null;

    /*
     * Explicit scheme. `localhost:8080` and `example.com:8080` also look like
     * `scheme:` so we only reject them when what follows is not a port.
     */
    var scheme = value.match(/^([a-z][a-z0-9+.-]*):/i);
    if (scheme) {
      var name = scheme[1].toLowerCase();
      if (name === "http" || name === "https") return value;
      if (!/^\d+([/?#].*)?$/.test(value.slice(scheme[0].length))) return null;
    }

    if (/^\/\//.test(value)) return location.protocol + value;
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(value)) return "https://" + value;
    if (/^localhost(:\d+)?([/?#].*)?$/i.test(value)) return "https://" + value;

    return searchUrlFor(value);
  }

  /* ---------- favicons / cloak ---------- */

  function svgIcon(body) {
    return "data:image/svg+xml," + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' + body + "</svg>"
    );
  }

  var ICONS = {
    joystick: svgIcon(
      '<rect width="32" height="32" rx="8" fill="#0b1220"/>' +
      '<path d="M10 21v-6a6 6 0 0 1 12 0v6" fill="none" stroke="#22d3ee" stroke-width="2.4" stroke-linecap="round"/>' +
      '<circle cx="13" cy="19" r="1.8" fill="#22d3ee"/><circle cx="19" cy="19" r="1.8" fill="#22d3ee"/>'
    ),
    docs: svgIcon(
      '<rect width="32" height="32" rx="7" fill="#1d4ed8"/>' +
      '<path d="M9 7h9l5 5v13H9z" fill="#dbeafe"/>' +
      '<path d="M18 7v5h5" fill="none" stroke="#93c5fd" stroke-width="2"/>' +
      '<path d="M12 17h8M12 21h6" stroke="#60a5fa" stroke-width="2" stroke-linecap="round"/>'
    ),
    board: svgIcon(
      '<rect width="32" height="32" rx="7" fill="#065f46"/>' +
      '<rect x="6" y="7" width="20" height="14" rx="2" fill="#ecfdf5"/>' +
      '<path d="M9 11h6M9 15h10" stroke="#10b981" stroke-width="2" stroke-linecap="round"/>' +
      '<path d="M13 24h6" stroke="#34d399" stroke-width="2" stroke-linecap="round"/>'
    ),
    blank: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#ffffff"/></svg>'),
  };

  function applyCloak() {
    var title = String(settings.cloakTitle || "").trim();
    document.title = title || CONFIG.siteName || "Ant Arcade";
    var icon = $("#favicon");
    if (icon) icon.href = ICONS[settings.cloakIcon] || ICONS.joystick;
  }

  function panic() {
    var target = String(settings.panicUrl || CONFIG.panicUrl || "about:blank").trim();
    if (!target) target = "about:blank";
    try {
      location.replace(target);
    } catch (e) {
      location.href = "about:blank";
    }
  }

  /* ---------- game library ---------- */

  var gameGrid = $("#gameGrid");
  var emptyState = $("#emptyState");
  var gameCount = $("#gameCount");

  function getGame(id) {
    for (var i = 0; i < GAMES.length; i++) if (GAMES[i].id === id) return GAMES[i];
    return null;
  }

  function categories() {
    var seen = { All: true };
    var list = ["All"];
    GAMES.forEach(function (game) {
      if (!seen[game.category]) {
        seen[game.category] = true;
        list.push(game.category);
      }
    });
    return list;
  }

  function renderChips() {
    var wrap = $("#categoryChips");
    if (!wrap) return;
    wrap.innerHTML = categories().map(function (category) {
      return '<button class="chip" type="button" data-cat="' + escapeAttr(category) +
        '" aria-pressed="' + (state.category === category) + '">' + escapeHtml(category) + "</button>";
    }).join("");
  }

  function filteredGames() {
    var query = state.query.trim().toLowerCase();
    return GAMES.filter(function (game) {
      if (state.favoritesOnly && !favorites.has(game.id)) return false;
      if (state.category !== "All" && game.category !== state.category) return false;
      if (!query) return true;
      var haystack = [game.title, game.category, game.desc, (game.tags || []).join(" "), game.id]
        .join(" ").toLowerCase();
      return haystack.indexOf(query) !== -1;
    });
  }

  function cardHtml(game) {
    var fav = favorites.has(game.id);
    var tags = (game.tags || []).slice(0, 2).map(function (tag) {
      return '<span class="mini-tag">' + escapeHtml(tag) + "</span>";
    }).join("");

    return '' +
      '<article class="game-card" data-id="' + escapeAttr(game.id) + '">' +
        '<button class="card-cover" type="button" data-open="' + escapeAttr(game.id) + '" ' +
          'style="--g1:' + escapeAttr(game.g1 || "#22d3ee") + ';--g2:' + escapeAttr(game.g2 || "#8b5cf6") + '" ' +
          'aria-label="Play ' + escapeAttr(game.title) + '">' +
          '<span class="card-badge">' + escapeHtml(game.category) + "</span>" +
          '<span class="card-emoji" aria-hidden="true">' + escapeHtml(game.emoji || "🎮") + "</span>" +
          '<span class="card-play">▶ Play</span>' +
        "</button>" +
        '<button class="fav-btn' + (fav ? " is-fav" : "") + '" type="button" data-fav="' + escapeAttr(game.id) + '" ' +
          'aria-label="' + (fav ? "Remove from favorites" : "Add to favorites") + '" aria-pressed="' + fav + '">' +
          (fav ? "★" : "☆") +
        "</button>" +
        '<div class="card-body" data-open="' + escapeAttr(game.id) + '">' +
          "<h3>" + escapeHtml(game.title) + "</h3>" +
          "<p>" + escapeHtml(game.desc) + "</p>" +
          '<div class="card-meta">' + tags + "</div>" +
        "</div>" +
      "</article>";
  }

  function renderGames() {
    var list = filteredGames();
    gameGrid.innerHTML = list.map(cardHtml).join("");
    emptyState.hidden = list.length > 0;
    gameGrid.hidden = list.length === 0;
    if (gameCount) gameCount.textContent = String(list.length);
  }

  function renderRecent() {
    var wrap = $("#recentWrap");
    var list = $("#recentList");
    if (!wrap || !list) return;
    var items = recents.map(getGame).filter(Boolean);
    wrap.hidden = items.length === 0;
    list.innerHTML = items.map(function (game) {
      return '<button class="recent-item" type="button" data-open="' + escapeAttr(game.id) + '">' +
        '<span aria-hidden="true">' + escapeHtml(game.emoji || "🎮") + "</span>" +
        escapeHtml(game.title) +
      "</button>";
    }).join("");
  }

  function toggleFavorite(id) {
    if (!getGame(id)) return;
    if (favorites.has(id)) {
      favorites.delete(id);
      toast("Removed from favorites");
    } else {
      favorites.add(id);
      toast("Added to favorites");
    }
    store.set(KEYS.favorites, Array.from(favorites));
    renderGames();
  }

  function recordRecent(id) {
    recents = [id].concat(recents.filter(function (item) { return item !== id; })).slice(0, 6);
    store.set(KEYS.recents, recents);
    renderRecent();
  }

  /* ---------- player ---------- */

  var playerOverlay = $("#playerOverlay");
  var playerFrame = $("#playerFrame");
  var playerSpinner = $("#playerSpinner");
  var playerStage = $("#playerStage");
  var playerProxyBtn = $("#playerProxyBtn");

  var player = { game: null, proxied: false, loadTimer: null };

  function updatePlayerProxyBtn() {
    if (!playerProxyBtn) return;
    playerProxyBtn.classList.toggle("is-on", !!player.proxied);
    playerProxyBtn.innerHTML = '<span class="pill-dot"></span> Proxy ' + (player.proxied ? "on" : "off");
    playerProxyBtn.title = player.proxied ? "Load this game directly" : "Route this game through the proxy";
  }

  function loadPlayer() {
    if (!player.game) return;
    var target = absoluteUrl(player.game.url);
    var src = player.proxied ? proxyUrlFor(target) : target;

    clearTimeout(player.loadTimer);
    playerSpinner.hidden = false;

    // about:blank first so that pressing reload always re-navigates.
    playerFrame.src = "about:blank";
    setTimeout(function () {
      playerFrame.src = src;
    }, 30);

    player.loadTimer = setTimeout(function () { playerSpinner.hidden = true; }, 9000);
  }

  function openGame(id, options) {
    options = options || {};
    var game = getGame(id);
    if (!game) return;

    player.game = game;
    player.proxied = options.proxy != null ? !!options.proxy : !!settings.proxyGames;

    $("#playerEmoji").textContent = game.emoji || "🎮";
    $("#playerName").textContent = game.title;
    $("#playerCategory").textContent = game.category;

    playerOverlay.hidden = false;
    document.body.classList.add("no-scroll");
    updatePlayerProxyBtn();
    loadPlayer();
    recordRecent(id);

    if (!options.silentHash) setHash("#play/" + encodeURIComponent(id));
  }

  function closeGame() {
    if (playerOverlay.hidden) return;
    clearTimeout(player.loadTimer);
    playerFrame.src = "about:blank";
    playerOverlay.hidden = true;
    player.game = null;
    if (proxyOverlay.hidden && $("#settingsModal").hidden) document.body.classList.remove("no-scroll");
    setHash("#games");
  }

  /* ---------- proxy browser ---------- */

  var proxyOverlay = $("#proxyOverlay");
  var proxyFrame = $("#proxyFrame");
  var proxySpinner = $("#proxySpinner");
  var proxyAddress = $("#proxyAddress");
  var proxyNotice = $("#proxyNotice");
  var proxyNav = { stack: [], index: -1, current: "" };

  function updateProxyNav() {
    $("#proxyBack").disabled = proxyNav.index <= 0;
    $("#proxyForward").disabled = proxyNav.index >= proxyNav.stack.length - 1;
  }

  function navigateProxy(input, options) {
    options = options || {};
    var url = normalizeInput(input);
    if (!url) {
      toast("Enter a URL like example.com");
      return;
    }

    if (!proxyConfigured()) {
      proxyNav.current = url;
      proxyAddress.value = url;
      setHash("#proxy/" + encodeURIComponent(url));
      showProxyNotice();
      return;
    }

    if (options.push !== false) {
      proxyNav.stack = proxyNav.stack.slice(0, proxyNav.index + 1);
      if (proxyNav.stack[proxyNav.index] !== url) {
        proxyNav.stack.push(url);
        proxyNav.index = proxyNav.stack.length - 1;
      }
    }

    proxyNav.current = url;
    proxyAddress.value = url;
    proxySpinner.hidden = false;
    proxyNotice.hidden = true;

    var src = proxyUrlFor(url);
    proxyFrame.src = "about:blank";
    setTimeout(function () { proxyFrame.src = src; }, 20);

    updateProxyNav();
    if (!options.silentHash) setHash("#proxy/" + encodeURIComponent(url));

    testProxy().then(function (ok) {
      if (!ok && !proxyOverlay.hidden) showProxyNotice();
    });
  }

  function openProxy(url, options) {
    options = options || {};
    proxyOverlay.hidden = false;
    document.body.classList.add("no-scroll");

    // Added on first use so the arcade page itself loads without a sandbox
    // warning. allow-same-origin keeps storage/cookies working for proxied
    // sites; omitting allow-top-navigation stops frame-busting scripts from
    // replacing the arcade tab with the destination site.
    if (!proxyFrame.hasAttribute("sandbox")) {
      proxyFrame.setAttribute(
        "sandbox",
        "allow-scripts allow-forms allow-same-origin allow-popups " +
        "allow-popups-to-escape-sandbox allow-downloads allow-modals allow-pointer-lock"
      );
    }

    if (!options.keepStack) {
      proxyNav = { stack: [], index: -1, current: "" };
    }

    var engine = selectedEngine();
    var start = url || engine.home || "https://www.bing.com/";
    navigateProxy(start, { push: true, silentHash: options.silentHash });
  }

  function closeProxy() {
    if (proxyOverlay.hidden) return;
    proxyFrame.src = "about:blank";
    proxyOverlay.hidden = true;
    proxyNav = { stack: [], index: -1, current: "" };
    if (playerOverlay.hidden && $("#settingsModal").hidden) document.body.classList.remove("no-scroll");
    setHash("#games");
  }

  function proxyGoBack() {
    if (proxyNav.index <= 0) return;
    proxyNav.index -= 1;
    navigateProxy(proxyNav.stack[proxyNav.index], { push: false });
  }

  function proxyGoForward() {
    if (proxyNav.index >= proxyNav.stack.length - 1) return;
    proxyNav.index += 1;
    navigateProxy(proxyNav.stack[proxyNav.index], { push: false });
  }

  function syncProxyLocation(url) {
    if (!url || !isHttp(url)) return;
    if (proxyNav.current === url) return;
    proxyNav.current = url;
    proxyAddress.value = url;
    if (proxyNav.index >= 0) proxyNav.stack[proxyNav.index] = url;
    setHash("#proxy/" + encodeURIComponent(url));
  }

  /* ---------- settings ---------- */

  var settingsModal = $("#settingsModal");

  function openSettings() {
    $("#setTitle").value = settings.cloakTitle || "";
    $("#setIcon").value = settings.cloakIcon || "joystick";
    $("#setPanic").value = settings.panicUrl || CONFIG.panicUrl || "";
    $("#setProxyBase").value = settings.proxyBase || CONFIG.proxyBase || "p";
    $("#setProxyGames").value = settings.proxyGames ? "yes" : "no";
    settingsModal.hidden = false;
    document.body.classList.add("no-scroll");
    setTimeout(function () { $("#setTitle").focus(); }, 40);
  }

  function closeSettings() {
    settingsModal.hidden = true;
    if (playerOverlay.hidden && proxyOverlay.hidden) document.body.classList.remove("no-scroll");
  }

  function saveSettings() {
    settings.cloakTitle = $("#setTitle").value.trim();
    settings.cloakIcon = $("#setIcon").value;
    settings.panicUrl = $("#setPanic").value.trim() || DEFAULT_SETTINGS.panicUrl;
    settings.proxyBase = $("#setProxyBase").value.trim() || "p";
    settings.proxyGames = $("#setProxyGames").value === "yes";

    resetProxyProbe();
    store.set(KEYS.settings, settings);
    applyCloak();
    closeSettings();
    toast("Settings saved");
  }

  function resetAll() {
    if (!window.confirm("Reset favorites, recents and settings?")) return;
    store.remove(KEYS.settings);
    store.remove(KEYS.favorites);
    store.remove(KEYS.recents);
    settings = Object.assign({}, DEFAULT_SETTINGS);
    favorites = new Set();
    recents = [];
    state = { query: "", category: "All", favoritesOnly: false };
    $("#searchInput").value = "";
    $("#favoritesToggle").setAttribute("aria-pressed", "false");
    renderChips();
    renderGames();
    renderRecent();
    applyCloak();
    if ($("#proxyEngine")) $("#proxyEngine").value = selectedEngine().id;
    resetProxyProbe();
    closeSettings();
    toast("Everything reset");
  }

  /* ---------- init events ---------- */

  function focusSearch() {
    var section = $("#games");
    if (section) section.scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(function () {
      var input = $("#searchInput");
      if (input) input.focus({ preventScroll: true });
    }, 250);
  }

  function bind() {
    gameGrid.addEventListener("click", function (event) {
      var fav = event.target.closest("[data-fav]");
      if (fav) {
        event.stopPropagation();
        toggleFavorite(fav.getAttribute("data-fav"));
        return;
      }
      var open = event.target.closest("[data-open]");
      if (open) openGame(open.getAttribute("data-open"));
    });

    $("#recentList").addEventListener("click", function (event) {
      var open = event.target.closest("[data-open]");
      if (open) openGame(open.getAttribute("data-open"));
    });

    $("#searchInput").addEventListener("input", function (event) {
      state.query = event.target.value;
      renderGames();
    });

    $("#searchJump").addEventListener("click", focusSearch);

    $("#categoryChips").addEventListener("click", function (event) {
      var chip = event.target.closest("[data-cat]");
      if (!chip) return;
      state.category = chip.getAttribute("data-cat");
      renderChips();
      renderGames();
    });

    $("#favoritesToggle").addEventListener("click", function () {
      state.favoritesOnly = !state.favoritesOnly;
      this.setAttribute("aria-pressed", String(state.favoritesOnly));
      renderGames();
    });

    $("#clearFilters").addEventListener("click", function () {
      state = { query: "", category: "All", favoritesOnly: false };
      $("#searchInput").value = "";
      $("#favoritesToggle").setAttribute("aria-pressed", "false");
      renderChips();
      renderGames();
    });

    $$("[data-open-proxy]").forEach(function (button) {
      button.addEventListener("click", function () { openProxy(); });
    });

    $("#heroSearch").addEventListener("submit", function (event) {
      event.preventDefault();
      var input = $("#heroSearchInput");
      var query = input.value.trim();
      // A bare word becomes an engine search; example.com opens directly.
      openProxy(normalizeInput(query) || selectedEngine().home);
      input.value = "";
    });

    var engineSelect = $("#proxyEngine");
    if (engineSelect) {
      engineSelect.innerHTML = ENGINES.map(function (engine) {
        return '<option value="' + escapeAttr(engine.id) + '">' + escapeHtml(engine.label) + "</option>";
      }).join("");
      engineSelect.value = selectedEngine().id;
      engineSelect.addEventListener("change", function () {
        settings.engine = engineSelect.value;
        store.set(KEYS.settings, settings);
        toast("Search engine: " + selectedEngine().label);
      });
    }

    $("#settingsBtn").addEventListener("click", openSettings);
    $("#footerSettings").addEventListener("click", openSettings);
    $("#closeSettings").addEventListener("click", closeSettings);
    $("#cancelSettings").addEventListener("click", closeSettings);
    $("#saveSettings").addEventListener("click", saveSettings);
    $("#resetSettings").addEventListener("click", resetAll);

    settingsModal.addEventListener("click", function (event) {
      if (event.target === settingsModal) closeSettings();
    });

    $("#panicBtn").addEventListener("click", panic);

    /* player */
    $("#playerClose").addEventListener("click", closeGame);
    $("#playerReload").addEventListener("click", loadPlayer);

    $("#playerProxyBtn").addEventListener("click", function () {
      if (!proxyConfigured()) {
        toast("Proxy needs a hosted deployment — see README");
        return;
      }
      player.proxied = !player.proxied;
      updatePlayerProxyBtn();
      loadPlayer();
      toast(player.proxied ? "Loading through proxy" : "Loading directly");
    });

    $("#playerNewTab").addEventListener("click", function () {
      if (!player.game) return;
      var target = absoluteUrl(player.game.url);
      window.open(player.proxied ? proxyUrlFor(target) : target, "_blank", "noopener");
    });

    $("#playerFullscreen").addEventListener("click", function () {
      if (document.fullscreenElement) {
        document.exitFullscreen();
        return;
      }
      if (playerStage.requestFullscreen) {
        var request = playerStage.requestFullscreen();
        if (request && typeof request.catch === "function") {
          request.catch(function () { toast("Fullscreen was blocked"); });
        }
      }
    });

    playerFrame.addEventListener("load", function () {
      if (playerFrame.src === "about:blank") return;
      playerSpinner.hidden = true;
    });

    /* proxy */
    $("#proxyClose").addEventListener("click", closeProxy);
    $("#proxyBack").addEventListener("click", proxyGoBack);
    $("#proxyForward").addEventListener("click", proxyGoForward);
    $("#proxyReload").addEventListener("click", function () {
      if (proxyNav.current) navigateProxy(proxyNav.current, { push: false });
    });

    $("#proxyForm").addEventListener("submit", function (event) {
      event.preventDefault();
      navigateProxy(proxyAddress.value);
      proxyAddress.blur();
    });

    $("#proxyNewTab").addEventListener("click", function () {
      if (proxyNav.current) window.open(proxyUrlFor(proxyNav.current), "_blank", "noopener");
    });

    $("#proxyQuick").addEventListener("click", function (event) {
      var button = event.target.closest("[data-proxy-go]");
      if (button) navigateProxy(button.getAttribute("data-proxy-go"));
    });

    proxyFrame.addEventListener("load", function () {
      if (proxyFrame.src === "about:blank") return;
      proxySpinner.hidden = true;
      try {
        var doc = proxyFrame.contentDocument;
        if (doc && doc.body) {
          // python -m http.server answers /p with its own 404 page. Detect that
          // exact page so a static-only preview explains the problem.
          var title = String(doc.title || "").toLowerCase().trim();
          var text = String(doc.body.textContent || "").toLowerCase();
          if (title === "error response" && text.indexOf("nothing matches the given uri") !== -1) {
            proxyNotice.hidden = false;
            proxySpinner.hidden = true;
            return;
          }
        }
      } catch (e) {
        // Cross-origin worker: the injected proxy shim reports navigation instead.
      }
      try {
        var current = proxyFrame.contentWindow.location.href;
        var target = targetFromProxyUrl(current);
        if (target) syncProxyLocation(target);
      } catch (e) {
        // Cross-origin worker: the injected proxy shim reports navigation instead.
      }
    });

    $("#proxyNoticeClose").addEventListener("click", function () {
      proxyNotice.hidden = true;
    });

    var proxyNoticeSettings = $("#proxyNoticeSettings");
    if (proxyNoticeSettings) {
      proxyNoticeSettings.addEventListener("click", function () {
        proxyNotice.hidden = true;
        openSettings();
      });
    }

    window.addEventListener("message", function (event) {
      if (proxyOverlay.hidden) return;
      if (event.source !== proxyFrame.contentWindow) return;
      var data = event.data;
      if (!data || data.__arcadeProxy !== true) return;
      if (typeof data.url === "string" && isHttp(data.url)) {
        syncProxyLocation(data.url);
        proxySpinner.hidden = true;
      }
    });

    /* keyboard */
    document.addEventListener("keydown", function (event) {
      var target = event.target;
      var typing = target && target.closest && target.closest("input, textarea, select, [contenteditable='true']");

      if (event.code === "Backquote" && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        panic();
        return;
      }

      if (event.ctrlKey && event.shiftKey && String(event.key).toLowerCase() === "x") {
        event.preventDefault();
        panic();
        return;
      }

      if (event.key === "/" && !typing) {
        event.preventDefault();
        focusSearch();
        return;
      }

      if (event.key === "Escape") {
        if (!settingsModal.hidden) { closeSettings(); return; }
        if (!playerOverlay.hidden) { closeGame(); return; }
        if (!proxyOverlay.hidden) { closeProxy(); return; }
      }
    });

    /* deep links: #play/<id> and #proxy/<encoded url> */
    var hash = "";
    try { hash = decodeURIComponent(location.hash.replace(/^#/, "")); } catch (e) { hash = ""; }

    if (hash.indexOf("play/") === 0) {
      var id = hash.slice(5);
      if (getGame(id)) {
        setTimeout(function () { openGame(id, { silentHash: true }); }, 60);
      }
    } else if (hash.indexOf("proxy/") === 0) {
      var proxyTarget = hash.slice(6);
      if (isHttp(proxyTarget)) {
        setTimeout(function () { openProxy(proxyTarget, { silentHash: true }); }, 60);
      }
    }
  }

  /* ---------- boot ---------- */

  var total = GAMES.length;
  $$("[data-game-count]").forEach(function (el) { el.textContent = String(total); });

  applyCloak();
  renderChips();
  renderGames();
  renderRecent();
  bind();
})();
