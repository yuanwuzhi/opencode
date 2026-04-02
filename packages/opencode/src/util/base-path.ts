export function normalizeBasePath(path?: string): string {
  if (!path || path === "/") return ""

  let normalized = path.startsWith("/") ? path : `/${path}`
  normalized = normalized.replace(/\/+$/, "")

  return normalized
}

export function joinPath(basePath: string, ...segments: string[]): string {
  const base = normalizeBasePath(basePath)
  const path = segments.join("/").replace(/\/+/g, "/")
  return `${base}${path.startsWith("/") ? path : `/${path}`}`
}

export function generateBasePathScript(basePath: string): string {
  return `<script>
window.__OPENCODE_BASE_PATH__="${basePath}";
(function() {
  var basePath = window.__OPENCODE_BASE_PATH__ || "";
  if (!basePath) return;

  try {
    var serverUrl = location.origin + basePath;
    localStorage.setItem("opencode.settings.dat:defaultServerUrl", serverUrl);
  } catch(e) {}

  var origPushState = history.pushState.bind(history);
  var origReplaceState = history.replaceState.bind(history);

  function addBasePathIfNeeded(url) {
    if (!url || typeof url !== "string") return url;
    if (url.startsWith("/") && !url.startsWith(basePath)) {
      return basePath + url;
    }
    return url;
  }

  history.pushState = function(state, title, url) {
    return origPushState(state, title, addBasePathIfNeeded(url));
  };

  history.replaceState = function(state, title, url) {
    return origReplaceState(state, title, addBasePathIfNeeded(url));
  };
})();
</script>`
}

export function rewriteHtmlForBasePath(html: string, basePath: string): string {
  if (!basePath) return html

  let result = html.replace(/(href|src|content)="\/(?!\/)/g, `$1="${basePath}/`)

  result = result.replace("</head>", `${generateBasePathScript(basePath)}</head>`)

  return result
}

export function rewriteJsForBasePath(js: string, basePath: string): string {
  if (!basePath) return js

  let result = js

  result = result.replace(
    /:window\.location\.origin([;),])/g,
    `:window.location.origin+(window.__OPENCODE_BASE_PATH__||"")$1`,
  )

  result = result.replace(
    /:location\.origin([;),])/g,
    `:location.origin+(window.__OPENCODE_BASE_PATH__||"")$1`,
  )

  result = result.replace(/function\(t\)\{return"\/"\+t\}/g, `function(t){return"${basePath}/"+t}`)

  return result
}

export function rewriteCssForBasePath(css: string, basePath: string): string {
  if (!basePath) return css

  return css.replace(/url\(\/(?!\/)/g, `url(${basePath}/`)
}
