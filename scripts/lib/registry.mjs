const ALLOWED_SOURCE_KINDS = new Set([
  "fact",
  "fact-source",
  "visual-reference",
  "embedded-asset",
  "font-reference",
  "icon-source",
  "replica-source"
]);

const ALLOWED_ASSET_LICENSE_STATUSES = new Set([
  "allowed",
  "allowed-with-attribution",
  "user-provided",
  "public-domain",
  "unknown"
]);

export function validateSourceRegistry(registry) {
  const issues = [];
  if (!registry || typeof registry !== "object") {
    return { valid: false, issues: [issue("error", "source-registry-invalid", "source registry must be an object")] };
  }

  for (const item of registry.items ?? []) {
    if (!item || typeof item !== "object") {
      issues.push(issue("error", "source-item-invalid", "source item must be an object"));
      continue;
    }
    if (!item.id) issues.push(issue("error", "source-id-required", "source item is missing id"));
    if (!item.kind) issues.push(issue("error", "source-kind-required", `${item.id ?? "source"} is missing kind`));
    if (item.kind && !ALLOWED_SOURCE_KINDS.has(item.kind)) {
      issues.push(issue("warning", "source-kind-unknown", `${item.id ?? "source"} uses unknown kind ${item.kind}`));
    }
    if (item.url && !/^https?:\/\//.test(item.url)) {
      issues.push(issue("error", "source-url-invalid", `${item.id ?? "source"} url must be http or https`));
    }
  }

  return result(issues);
}

export function validateAssetRegistry(registry) {
  const issues = [];
  if (!registry || typeof registry !== "object") {
    return { valid: false, issues: [issue("error", "asset-registry-invalid", "asset registry must be an object")] };
  }

  for (const asset of registry.assets ?? []) {
    if (!asset || typeof asset !== "object") {
      issues.push(issue("error", "asset-item-invalid", "asset must be an object"));
      continue;
    }
    if (!asset.id) issues.push(issue("error", "asset-id-required", "asset is missing id"));
    if (!asset.localPath) issues.push(issue("error", "asset-local-path-required", `${asset.id ?? "asset"} is missing localPath`));
    const status = asset.license?.status;
    if (!ALLOWED_ASSET_LICENSE_STATUSES.has(status)) {
      issues.push(issue("error", "asset-license-status-invalid", `${asset.id ?? "asset"} has unsupported license status`));
    }
    if (asset.finalDeckUse === "embedded" && asset.sourceUrl && status === "unknown") {
      issues.push(issue("error", "asset-license-blocked", `${asset.id ?? "asset"} cannot be embedded with unknown license`));
    }
  }

  return result(issues);
}

export function summarizeRegistry({ sources, assets }) {
  const sourceItems = sources?.items ?? [];
  const assetItems = assets?.assets ?? [];
  return {
    sourceCount: sourceItems.length,
    assetCount: assetItems.length,
    embeddedAssetCount: assetItems.filter((asset) => asset.finalDeckUse === "embedded").length
  };
}

function result(issues) {
  return { valid: issues.every((entry) => entry.severity !== "error"), issues };
}

function issue(severity, code, message) {
  return { severity, code, message };
}
