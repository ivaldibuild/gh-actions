// Runs the action end to end against a fake GitHub API.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { run } from "../src/main.mjs";

const skip = process.platform === "win32" ? "the fake binary is a shell script" : false;

const VERSION = "1.2.0";
const ARCHIVE = `ivaldictl_${VERSION}_linux_amd64.tar.gz`;
const TOKEN = "ghs_test";

let api;
let storage;
let archive;
let checksums;
const requests = [];

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const url = (server) => `http://127.0.0.1:${server.address().port}`;

before(async () => {
  if (skip) return;
  // A fake ivaldictl that reports what it was run with.
  const src = mkdtempSync(join(tmpdir(), "fake-ivaldictl-"));
  const bin = join(src, "ivaldictl");
  writeFileSync(
    bin,
    `#!/bin/sh\necho "fake ivaldictl $* server=$IVALDI_SERVER_URL token=\${IVALDI_API_TOKEN:+set}" >>"$FAKE_IVALDICTL_LOG"\n`,
  );
  chmodSync(bin, 0o755);
  execFileSync("tar", ["-czf", join(src, ARCHIVE), "-C", src, "ivaldictl"]);
  archive = readFileSync(join(src, ARCHIVE));
  checksums = `${createHash("sha256").update(archive).digest("hex")}  ./${ARCHIVE}\n`;

  // Release assets live on another origin, as on github.com.
  storage = await listen((req, res) => {
    requests.push({ host: "storage", url: req.url, auth: req.headers.authorization });
    if (req.url === `/${ARCHIVE}`) return res.end(archive);
    if (req.url === "/checksums.txt") return res.end(checksums);
    if (req.url === "/bad-checksums.txt") return res.end(`${"0".repeat(64)}  ./ivaldictl_6.6.6_linux_amd64.tar.gz\n`);
    res.statusCode = 404;
    res.end();
  });

  api = await listen((req, res) => {
    requests.push({ host: "api", url: req.url, auth: req.headers.authorization });
    const base = url(api);
    const release = (tag, extra = {}) => ({
      tag_name: tag,
      draft: false,
      prerelease: false,
      html_url: `https://github.example/${tag}`,
      assets: [
        { name: "checksums.txt", url: `${base}/assets/checksums.txt` },
        { name: ARCHIVE, url: `${base}/assets/${ARCHIVE}` },
      ],
      ...extra,
    });
    res.setHeader("content-type", "application/json");
    if (req.url === "/repos/acme/ivaldi/releases?per_page=100") {
      res.setHeader("link", `<${base}/repos/acme/ivaldi/releases?per_page=100&page=2>; rel="next"`);
      return res.end(JSON.stringify([release("ivaldi/v9.0.0"), release("ivaldictl/v1.3.0-rc.1")]));
    }
    if (req.url === "/repos/acme/ivaldi/releases?per_page=100&page=2") {
      return res.end(JSON.stringify([release(`ivaldictl/v${VERSION}`), release("ivaldictl/v1.1.0")]));
    }
    if (req.url === "/repos/acme/ivaldi/releases/tags/ivaldictl/v6.6.6") {
      // Assets whose checksum will not match.
      return res.end(
        JSON.stringify(
          release("ivaldictl/v6.6.6", {
            assets: [
              { name: "checksums.txt", url: `${base}/assets/bad-checksums.txt` },
              { name: "ivaldictl_6.6.6_linux_amd64.tar.gz", url: `${base}/assets/${ARCHIVE}` },
            ],
          }),
        ),
      );
    }
    if (req.url.startsWith("/assets/")) {
      if (req.headers.accept !== "application/octet-stream") {
        res.statusCode = 415;
        return res.end();
      }
      res.statusCode = 302;
      res.setHeader("location", `${url(storage)}/${req.url.slice("/assets/".length)}`);
      return res.end();
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: "Not Found" }));
  });
});

after(() => {
  api?.close();
  storage?.close();
});

function runner(inputs) {
  const root = mkdtempSync(join(tmpdir(), "runner-"));
  const files = {};
  for (const name of ["GITHUB_PATH", "GITHUB_ENV", "GITHUB_OUTPUT", "FAKE_IVALDICTL_LOG"]) {
    files[name] = join(root, name);
    writeFileSync(files[name], "");
  }
  mkdirSync(join(root, "temp"));
  const env = {
    PATH: process.env.PATH,
    RUNNER_TEMP: join(root, "temp"),
    RUNNER_TOOL_CACHE: join(root, "cache"),
    ...files,
    "INPUT_GITHUB-API-URL": url(api),
    INPUT_REPOSITORY: "acme/ivaldi",
    "INPUT_GITHUB-TOKEN": TOKEN,
    INPUT_VERSION: "latest",
    INPUT_PRERELEASE: "false",
    INPUT_VERIFY: "false",
    ...Object.fromEntries(Object.entries(inputs).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v])),
  };
  const read = (name) => readFileSync(files[name], "utf8");
  const parse = (name) => {
    const out = {};
    const re = /^(.+?)<<(ghadelimiter_[\w-]+)\n([\s\S]*?)\n\2$/gm;
    for (const m of read(name).matchAll(re)) out[m[1]] = m[3];
    return out;
  };
  return { env, read, parse, root };
}

test("installs the latest stable release, verifies it, and caches it", { skip }, async () => {
  requests.length = 0;
  const r = runner({
    "server-url": "https://ivaldi.example.com",
    "api-token": "ivt_secret",
    verify: "true",
  });
  await run({ env: r.env, platform: "linux", arch: "x64" });

  const outputs = r.parse("GITHUB_OUTPUT");
  const dir = join(r.root, "cache", "ivaldictl", VERSION, "amd64");
  assert.deepEqual(outputs, { version: VERSION, path: dir, "cache-hit": "false" });
  assert.equal(r.read("GITHUB_PATH"), `${dir}\n`);
  assert.deepEqual(r.parse("GITHUB_ENV"), {
    IVALDI_SERVER_URL: "https://ivaldi.example.com",
    IVALDI_API_TOKEN: "ivt_secret",
  });
  assert.ok(existsSync(join(dir, "ivaldictl")));
  // Nothing is left behind: no staging directory beside the entry, no download.
  assert.deepEqual(readdirSync(join(dir, "..")).sort(), ["amd64", "amd64.complete"]);
  assert.deepEqual(readdirSync(r.env.RUNNER_TEMP), []);
  assert.equal(
    r.read("FAKE_IVALDICTL_LOG"),
    "fake ivaldictl --version server=https://ivaldi.example.com token=set\n" +
      "fake ivaldictl auth status server=https://ivaldi.example.com token=set\n",
  );

  // The token goes to the API and never follows the redirect to storage.
  assert.ok(requests.filter((q) => q.host === "api").every((q) => q.auth === `Bearer ${TOKEN}`));
  const fromStorage = requests.filter((q) => q.host === "storage");
  assert.deepEqual(fromStorage.map((q) => q.url).sort(), ["/checksums.txt", `/${ARCHIVE}`]);
  assert.ok(fromStorage.every((q) => q.auth === undefined));

  // A second run on the same runner reuses the cache.
  requests.length = 0;
  writeFileSync(r.env.GITHUB_OUTPUT, "");
  await run({ env: { ...r.env, INPUT_VERSION: `v${VERSION}`, "INPUT_API-TOKEN": "", INPUT_VERIFY: "false" }, platform: "linux", arch: "x64" });
  assert.equal(r.parse("GITHUB_OUTPUT")["cache-hit"], "true");
  assert.ok(!requests.some((q) => q.host === "storage"));
});

test("considers pre-releases when asked", { skip }, async () => {
  const r = runner({ prerelease: "true" });
  await assert.rejects(
    run({ env: r.env, platform: "linux", arch: "x64" }),
    /checksums\.txt of ivaldictl\/v1\.3\.0-rc\.1 lists no 'ivaldictl_1\.3\.0-rc\.1_linux_amd64\.tar\.gz'/,
  );
});

test("refuses an archive whose checksum does not match", { skip }, async () => {
  const r = runner({ version: "6.6.6" });
  await assert.rejects(
    run({ env: r.env, platform: "linux", arch: "x64" }),
    /checksum mismatch for ivaldictl_6\.6\.6_linux_amd64\.tar\.gz: expected 0{64}/,
  );
});

test("explains a missing release in a private repository", { skip }, async () => {
  const r = runner({ version: "ivaldictl/v0.0.1" });
  await assert.rejects(
    run({ env: r.env, platform: "linux", arch: "x64" }),
    /404 .*'github-token' needs read access/,
  );
});

test("verify needs an API token", { skip }, async () => {
  const r = runner({ verify: "true" });
  await assert.rejects(run({ env: r.env, platform: "linux", arch: "x64" }), /'verify' needs 'api-token'/);
});
