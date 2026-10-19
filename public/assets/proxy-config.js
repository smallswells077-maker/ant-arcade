/*
 * Optional deploy hook.
 *
 * GitHub Actions overwrites this file when the repository has an Actions
 * variable named PROXY_BASE (Settings -> Secrets and variables -> Actions ->
 * Variables). Set it to your hosted proxy, e.g.
 *
 *   PROXY_BASE = https://ant-proxy.example.workers.dev/p
 *
 * Leave it empty to fall back to the default "p" endpoint used by Cloudflare
 * Pages (see config.js).
 */
window.ANT_PROXY_BASE = "";
