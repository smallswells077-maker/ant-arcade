#!/usr/bin/env python3
"""
Build proxy/worker.standalone.js from functions/_lib/proxy.js.

The Pages Function can import the shared library, but Cloudflare's dashboard
"paste a Worker" editor cannot follow imports. This script inlines everything
into one ES module so you can paste a single file and deploy without Node.
"""

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "functions" / "_lib" / "proxy.js"
OUTPUT = ROOT / "proxy" / "worker.standalone.js"

HEADER = """/*
 * GENERATED FILE — do not edit by hand.
 * Source: functions/_lib/proxy.js
 * Rebuild: python tools/bundle_proxy.py
 *
 * Paste this whole file into the Cloudflare dashboard Worker editor,
 * then click Deploy.
 */

"""

FOOTER = """

export default {
  async fetch(request, env) {
    return handleProxy(request, env);
  },
};
"""


def main() -> None:
    source = SOURCE.read_text(encoding="utf-8")

    # Strip module exports; the bundle is a single module with one default export.
    source = re.sub(r"^export\s+", "", source, flags=re.MULTILINE)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(HEADER + source.rstrip() + FOOTER, encoding="utf-8")

    lines = OUTPUT.read_text(encoding="utf-8").count("\n") + 1
    print(f"Wrote {OUTPUT.relative_to(ROOT)} ({lines} lines)")


if __name__ == "__main__":
    main()
