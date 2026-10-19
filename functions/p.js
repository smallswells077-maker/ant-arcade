import { handleProxy } from "./_lib/proxy.js";

export function onRequest(context) {
  return handleProxy(context.request, context.env);
}
