import { handleProxy } from "./functions/_lib/proxy.js";

export default {
  fetch(request, env) {
    return handleProxy(request, env);
  },
};
