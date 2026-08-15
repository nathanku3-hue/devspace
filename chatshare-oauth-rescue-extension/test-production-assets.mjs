const routeUrl = new URL(
  "https://chatgpt-remix.openoai.net/cdn/assets/65d660dd/connector.oauth._callback_id-kvblfiqg.js",
);

const routeSource = await fetchText(routeUrl);
const supportUrls = extractImportUrls(routeSource, routeUrl);
let result = null;

for (const supportUrl of supportUrls) {
  const source = await fetchText(supportUrl);
  if (!source.includes("/aip/connectors/links/oauth/callback")) continue;

  const callbackMatch = source.match(
    /([A-Za-z_$][\w$]*)\.safePost\(`\/aip\/connectors\/links\/oauth\/callback`/,
  );
  if (!callbackMatch) throw new Error("Production callback client alias not found");

  const binding = findImportedBinding(source, supportUrl, callbackMatch[1]);
  const apiSource = await fetchText(binding.moduleUrl);
  if (!new RegExp(`\\b${binding.exportName}\\b`).test(apiSource)) {
    throw new Error("Production API client export not found in resolved module");
  }

  result = {
    supportModule: supportUrl.href,
    apiModule: binding.moduleUrl.href,
    apiExport: binding.exportName,
  };
  break;
}

if (!result) throw new Error("Production callback implementation not found");
console.log(JSON.stringify({ passed: true, ...result }, null, 2));

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url.href}: HTTP ${response.status}`);
  return response.text();
}

function extractImportUrls(source, sourceUrl) {
  const urls = [];
  const pattern = /from["']([^"']+\.js)["']/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    urls.push(new URL(match[1], sourceUrl));
  }
  return urls;
}

function findImportedBinding(source, sourceUrl, localAlias) {
  const importPattern = /import\{([^}]*)\}from["']([^"']+)["']/g;
  let match;
  while ((match = importPattern.exec(source)) !== null) {
    for (const binding of match[1].split(",")) {
      const parts = binding.trim().match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (parts && parts[2] === localAlias) {
        return {
          exportName: parts[1],
          moduleUrl: new URL(match[2], sourceUrl),
        };
      }
    }
  }
  throw new Error("Production callback API import not found");
}
