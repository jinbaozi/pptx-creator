import { lookup as dnsLookup } from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";
import { fail } from "./errors.mjs";

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

function normalizeHosts(value) {
  const values = Array.isArray(value) ? value : (value === undefined ? [] : [value]);
  const hosts = new Set();
  for (const value of values) {
    if (typeof value !== "string") fail("E_REMOTE_ASSET", "allowHosts must contain host names", { path: "$.allowHosts" });
    for (const rawHost of value.split(",")) {
      const host = rawHost.trim().toLowerCase();
      if (!host) continue;
      if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(host) || isIP(host)
          || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
        fail("E_REMOTE_ASSET", `allowHosts contains an invalid host: ${rawHost}`, { path: "$.allowHosts" });
      }
      hosts.add(host);
    }
  }
  return hosts;
}

function blockedIpv4(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [first, second] = octets;
  return first === 0 || first === 10 || first === 127 || first >= 224
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && (second === 0 || second === 168))
    || (first === 198 && (second === 18 || second === 19 || second === 51))
    || (first === 203 && second === 0);
}

function validateRemoteUrl(locator, allowHosts) {
  let url;
  try {
    url = new URL(locator);
  } catch {
    fail("E_REMOTE_ASSET", `Remote asset is not a valid URL: ${locator}`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    fail("E_REMOTE_ASSET", "Remote assets must use credential-free HTTPS on port 443");
  }
  if (!hostname || isIP(hostname) || hostname === "localhost" || hostname.endsWith(".localhost")
      || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    fail("E_REMOTE_ASSET", `Remote asset host is not public: ${hostname}`);
  }
  if (!allowHosts.has(hostname)) {
    fail("E_REMOTE_ASSET", `Remote asset host is not explicitly allowed: ${hostname}`, { path: "$.allowHosts" });
  }
  return url;
}

async function resolvePublicIpv4(hostname, lookup) {
  let records;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    fail("E_REMOTE_ASSET", `Cannot resolve approved remote asset host ${hostname}: ${error.message}`);
  }
  if (!Array.isArray(records) || records.length === 0) {
    fail("E_REMOTE_ASSET", `Approved remote asset host has no address: ${hostname}`);
  }
  if (records.some((record) => record.family !== 4 || blockedIpv4(record.address))) {
    fail("E_REMOTE_ASSET", `Approved remote asset host resolves to a blocked address: ${hostname}`);
  }
  return records[0].address;
}

function requestBytes(url, address, expectedMime, timeoutMs, request) {
  return new Promise((resolve, reject) => {
    const pending = request(url, {
      lookup(hostname, _options, callback) {
        if (hostname.toLowerCase() !== url.hostname.toLowerCase()) {
          callback(new Error("Unexpected DNS lookup host"));
          return;
        }
        callback(null, address, 4);
      },
      headers: { Accept: expectedMime },
      timeout: timeoutMs
    }, (response) => {
      const chunks = [];
      let total = 0;
      const declaredLength = Number(response.headers["content-length"]);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_DOWNLOAD_BYTES) {
        response.resume();
        reject(Object.assign(new Error("Response exceeds the byte limit"), { code: "E_ASSET_SIZE" }));
        return;
      }
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > MAX_DOWNLOAD_BYTES) {
          response.destroy(Object.assign(new Error("Response exceeds the byte limit"), { code: "E_ASSET_SIZE" }));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        bytes: Buffer.concat(chunks)
      }));
      response.on("error", reject);
    });
    pending.on("timeout", () => pending.destroy(Object.assign(new Error("Remote asset request timed out"), { code: "E_REMOTE_ASSET" })));
    pending.on("error", reject);
    pending.end();
  });
}

function responseMime(headers) {
  const value = headers?.["content-type"];
  if (typeof value !== "string") return null;
  return value.split(";", 1)[0].trim().toLowerCase();
}

/**
 * Returns an explicit-allowlist HTTPS fetcher for use by the asset localizer.
 * Each redirect is revalidated and every connection is pinned to a freshly
 * checked public IPv4 address; no fetch occurs until a plan selects a URL.
 */
export function createSecureAssetFetcher(options = {}) {
  const allowHosts = normalizeHosts(options.allowHosts);
  const timeoutMs = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    fail("E_REMOTE_ASSET", "timeoutMs must be from 1000 through 60000", { path: "$.timeoutMs" });
  }
  const lookup = options.lookup ?? dnsLookup;
  const request = options.request ?? https.request;
  if (typeof lookup !== "function" || typeof request !== "function") {
    fail("E_REMOTE_ASSET", "lookup and request must be functions", { path: "$.options" });
  }

  return async function fetchAsset(locator, context = {}) {
    const expectedMime = context.asset?.mime;
    let current = validateRemoteUrl(locator, allowHosts);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const address = await resolvePublicIpv4(current.hostname, lookup);
      let response;
      try {
        response = await requestBytes(current, address, expectedMime, timeoutMs, request);
      } catch (error) {
        fail(error?.code === "E_ASSET_SIZE" ? "E_ASSET_SIZE" : "E_REMOTE_ASSET", `Cannot fetch ${current.href}: ${error.message}`);
      }
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers.location;
        if (typeof location !== "string" || !location) fail("E_REMOTE_ASSET", `Redirect from ${current.href} has no location`);
        current = validateRemoteUrl(new URL(location, current).href, allowHosts);
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        fail("E_REMOTE_ASSET", `Remote asset returned HTTP ${response.statusCode}: ${current.href}`);
      }
      const actualMime = responseMime(response.headers);
      if (actualMime && expectedMime && actualMime !== expectedMime) {
        fail("E_ASSET_MIME", `Remote asset content type ${actualMime} does not match declared ${expectedMime}`);
      }
      return { bytes: response.bytes, url: current.href };
    }
    fail("E_REMOTE_ASSET", `Remote asset exceeded ${MAX_REDIRECTS} redirects: ${locator}`);
  };
}
