// setup-ivaldictl: installs the ivaldictl CLI from its GitHub Releases.
//
// Dependency-free on purpose: it speaks the runner's file-command protocol
// (GITHUB_PATH, GITHUB_ENV, GITHUB_OUTPUT) directly, so there is no bundle to
// rebuild and check in.

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  TAG_PREFIX,
  assetNames,
  nextPage,
  normalizeVersion,
  parseBool,
  parseChecksums,
  pickLatest,
  platformTarget,
} from "./lib.mjs";

const USER_AGENT = "ivaldibuild-setup-ivaldictl";

export async function run({ env = process.env, platform = process.platform, arch = process.arch } = {}) {
  const input = (name) => (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();

  const repository = input("repository") || "ivaldibuild/ivaldi";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error(`input 'repository' must be owner/name, not '${repository}'`);
  }
  const gh = github({
    api: (input("github-api-url") || "https://api.github.com").replace(/\/+$/, ""),
    repository,
    token: input("github-token"),
  });
  const prerelease = parseBool("prerelease", input("prerelease"));
  const verify = parseBool("verify", input("verify"));
  const serverURL = input("server-url");
  const apiToken = input("api-token");
  if (apiToken) mask(apiToken);
  if (verify && !apiToken) throw new Error("input 'verify' needs 'api-token'");

  const target = platformTarget(platform, arch);

  const cacheRoot = env.RUNNER_TOOL_CACHE || join(tmpdir(), "setup-ivaldictl-cache");
  const cached = (v) => {
    const dir = join(cacheRoot, "ivaldictl", v, target.arch);
    const marker = `${dir}.complete`;
    const { binary } = assetNames(v, target);
    return { dir, marker, hit: existsSync(marker) && existsSync(join(dir, binary)) };
  };

  // Resolve the version. A pinned version already in the tool cache needs no
  // call to GitHub at all.
  let version = normalizeVersion(input("version"));
  let release;
  if (version) {
    if (!cached(version).hit) release = await gh.release(`${TAG_PREFIX}${version}`);
  } else {
    const best = pickLatest(await gh.releases(), { prerelease });
    if (!best) {
      throw new Error(
        `${repository} has no published ${prerelease ? "" : "stable "}ivaldictl release` +
          (prerelease ? "" : "; set 'prerelease: true' to consider pre-releases, or pin 'version'"),
      );
    }
    ({ version, release } = best);
  }

  const { archive, binary } = assetNames(version, target);
  const { dir, marker, hit: cacheHit } = cached(version);

  if (cacheHit) {
    info(`Found ivaldictl ${version} in the tool cache: ${dir}`);
  } else {
    info(`Installing ivaldictl ${version} from ${release.html_url ?? release.tag_name}`);
    const asset = (name) => {
      const a = (release.assets ?? []).find((x) => x.name === name);
      if (!a) throw new Error(`release ${release.tag_name} has no asset '${name}'`);
      return a;
    };
    const sums = parseChecksums((await gh.asset(asset("checksums.txt"))).toString("utf8"));
    const want = sums.get(archive);
    if (!want) throw new Error(`checksums.txt of ${release.tag_name} lists no '${archive}'`);

    info(`Downloading ${archive}`);
    const data = await gh.asset(asset(archive));
    const got = createHash("sha256").update(data).digest("hex");
    if (got !== want) {
      throw new Error(`checksum mismatch for ${archive}: expected ${want}, got ${got}`);
    }
    info(`Verified sha256 ${got}`);

    const temp = join(env.RUNNER_TEMP || tmpdir(), `setup-ivaldictl-${randomUUID()}`);
    const staging = join(temp, "out");
    mkdirSync(staging, { recursive: true });
    try {
      const file = join(temp, archive);
      writeFileSync(file, data);
      extract(file, staging, platform, env);
      if (!existsSync(join(staging, binary))) throw new Error(`${archive} holds no '${binary}'`);

      rmSync(dir, { recursive: true, force: true });
      rmSync(marker, { force: true });
      mkdirSync(join(dir, ".."), { recursive: true });
      renameSync(staging, dir);
      writeFileSync(marker, "");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }

  addPath(env, dir);
  if (serverURL) exportVariable(env, "IVALDI_SERVER_URL", serverURL);
  if (apiToken) exportVariable(env, "IVALDI_API_TOKEN", apiToken);

  setOutput(env, "version", version);
  setOutput(env, "path", dir);
  setOutput(env, "cache-hit", String(cacheHit));

  // The file commands only reach later steps; this process runs the binary
  // with the same settings itself.
  const childEnv = { ...env, PATH: `${dir}${platform === "win32" ? ";" : ":"}${env.PATH ?? ""}` };
  if (serverURL) childEnv.IVALDI_SERVER_URL = serverURL;
  if (apiToken) childEnv.IVALDI_API_TOKEN = apiToken;
  const bin = join(dir, binary);
  execFileSync(bin, ["--version"], { stdio: "inherit", env: childEnv });
  if (verify) {
    group("ivaldictl auth status", () => {
      execFileSync(bin, ["auth", "status"], { stdio: "inherit", env: childEnv });
    });
  }
}

// --- GitHub ----------------------------------------------------------------

function github({ api, repository, token }) {
  const headers = {
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const base = `${api}/repos/${repository}`;

  async function get(url, accept) {
    const res = await fetchWithRetry(url, { headers: { ...headers, Accept: accept } });
    if (res.ok) return res;
    const body = await res.text().catch(() => "");
    let hint = "";
    if (res.status === 404) {
      hint = token
        ? ` If ${repository} is private, 'github-token' needs read access to its contents.`
        : ` If ${repository} is private, pass a 'github-token' that can read it.`;
    } else if (res.status === 401) {
      hint = " Check 'github-token'.";
    } else if (res.status === 403 || res.status === 429) {
      hint = " GitHub may be rate limiting this runner; pass a 'github-token'.";
    }
    throw new Error(`GET ${url}: ${res.status} ${res.statusText} ${body.slice(0, 200)}`.trim() + hint);
  }

  return {
    async release(tag) {
      return (await get(`${base}/releases/tags/${tag}`, "application/vnd.github+json")).json();
    },
    async releases() {
      const all = [];
      let url = `${base}/releases?per_page=100`;
      while (url) {
        const res = await get(url, "application/vnd.github+json");
        all.push(...(await res.json()));
        url = nextPage(res.headers.get("link"));
      }
      return all;
    },
    async asset(a) {
      // The API URL serves private and public assets alike. Its redirect goes
      // to another origin, and fetch drops Authorization when it follows it.
      const res = await get(a.url, "application/octet-stream");
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

async function fetchWithRetry(url, init, attempts = 4) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, init);
      if (res.status < 500 || i >= attempts) return res;
      warning(`GET ${url}: ${res.status}, retrying`);
    } catch (err) {
      if (i >= attempts) throw err;
      warning(`GET ${url}: ${err.message}, retrying`);
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** (i - 1)));
  }
}

// --- Archives --------------------------------------------------------------

function extract(file, dest, platform, env) {
  // On Windows, use the system bsdtar, which reads zip and takes drive-letter
  // paths; Git's GNU tar may come first on PATH and does neither.
  let tar = "tar";
  if (platform === "win32") {
    const system = join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32", "tar.exe");
    if (existsSync(system)) tar = system;
  }
  const args = file.endsWith(".zip") ? ["-xf", file, "-C", dest] : ["-xzf", file, "-C", dest];
  execFileSync(tar, args, { stdio: "inherit" });
}

// --- Runner file commands ----------------------------------------------------

function fileCommand(env, name, line, fallback) {
  const path = env[name];
  if (path) appendFileSync(path, `${line}\n`);
  else fallback();
}

function keyValue(key, value) {
  const delimiter = `ghadelimiter_${randomUUID()}`;
  return `${key}<<${delimiter}\n${value}\n${delimiter}`;
}

function addPath(env, dir) {
  fileCommand(env, "GITHUB_PATH", dir, () => console.log(`::add-path::${dir}`));
}

function exportVariable(env, key, value) {
  fileCommand(env, "GITHUB_ENV", keyValue(key, value), () => {});
}

function setOutput(env, key, value) {
  fileCommand(env, "GITHUB_OUTPUT", keyValue(key, value), () => {});
}

function mask(value) {
  console.log(`::add-mask::${value}`);
}

function info(msg) {
  console.log(msg);
}

function warning(msg) {
  console.log(`::warning::${msg}`);
}

function group(title, fn) {
  console.log(`::group::${title}`);
  try {
    return fn();
  } finally {
    console.log("::endgroup::");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run().catch((err) => {
    console.log(`::error::${String(err?.message ?? err).replace(/\r?\n/g, "%0A")}`);
    process.exitCode = 1;
  });
}
