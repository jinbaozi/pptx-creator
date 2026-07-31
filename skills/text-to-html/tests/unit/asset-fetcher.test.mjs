import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createSecureAssetFetcher } from "../../scripts/lib/asset-fetcher.mjs";

function fakeRequest(responseFactory) {
  return (url, options, callback) => {
    const request = new EventEmitter();
    request.end = () => {
      options.lookup(url.hostname, {}, (lookupError) => {
        if (lookupError) {
          request.emit("error", lookupError);
          return;
        }
        const response = responseFactory(url);
        callback(response);
        queueMicrotask(() => {
          for (const chunk of response.chunks ?? []) response.emit("data", chunk);
          response.emit("end");
        });
      });
    };
    request.destroy = (error) => request.emit("error", error);
    return request;
  };
}

function response(statusCode, headers = {}, chunks = []) {
  const value = new EventEmitter();
  value.statusCode = statusCode;
  value.headers = headers;
  value.chunks = chunks;
  value.resume = () => {};
  value.destroy = (error) => value.emit("error", error);
  return value;
}

test("secure fetcher requires an explicit public host allowlist before DNS or I/O", async () => {
  assert.throws(
    () => createSecureAssetFetcher({ allowHosts: ["localhost"] }),
    (error) => error.code === "E_REMOTE_ASSET"
  );

  let lookupCalls = 0;
  const fetcher = createSecureAssetFetcher({
    allowHosts: ["assets.example.test"],
    lookup: async () => {
      lookupCalls += 1;
      return [{ address: "8.8.8.8", family: 4 }];
    },
    request: fakeRequest(() => response(200))
  });
  await assert.rejects(
    () => fetcher("https://other.example.test/file.png", { asset: { mime: "image/png" } }),
    (error) => error.code === "E_REMOTE_ASSET"
  );
  assert.equal(lookupCalls, 0);
});

test("secure fetcher pins a checked public DNS answer and checks the response MIME", async () => {
  let requestCalls = 0;
  const fetcher = createSecureAssetFetcher({
    allowHosts: ["assets.example.test"],
    lookup: async (hostname) => {
      assert.equal(hostname, "assets.example.test");
      return [{ address: "8.8.8.8", family: 4 }];
    },
    request: fakeRequest(() => {
      requestCalls += 1;
      return response(200, { "content-type": "image/png" }, [Buffer.from([1, 2, 3])]);
    })
  });

  const result = await fetcher("https://assets.example.test/file.png", { asset: { mime: "image/png" } });
  assert.deepEqual(result.bytes, Buffer.from([1, 2, 3]));
  assert.equal(result.url, "https://assets.example.test/file.png");
  assert.equal(requestCalls, 1);
});

test("secure fetcher rejects private DNS answers and redirects to unapproved hosts", async () => {
  let requestCalls = 0;
  const privateDns = createSecureAssetFetcher({
    allowHosts: ["assets.example.test"],
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    request: fakeRequest(() => {
      requestCalls += 1;
      return response(200);
    })
  });
  await assert.rejects(
    () => privateDns("https://assets.example.test/file.png", { asset: { mime: "image/png" } }),
    (error) => error.code === "E_REMOTE_ASSET"
  );
  assert.equal(requestCalls, 0);

  const redirect = createSecureAssetFetcher({
    allowHosts: ["assets.example.test"],
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    request: fakeRequest(() => response(302, { location: "https://unapproved.example.test/file.png" }))
  });
  await assert.rejects(
    () => redirect("https://assets.example.test/file.png", { asset: { mime: "image/png" } }),
    (error) => error.code === "E_REMOTE_ASSET"
  );
});
