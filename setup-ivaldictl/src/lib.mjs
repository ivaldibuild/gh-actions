// Pure helpers for setup-ivaldictl, kept free of I/O so they can be unit tested.

export const TAG_PREFIX = "ivaldictl/v";

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Parses a SemVer string, or returns null. */
export function parseSemver(s) {
  const m = SEMVER.exec(s);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

/** Orders two SemVer strings by precedence (build metadata is ignored). */
export function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) throw new Error(`not a SemVer: ${!x ? a : b}`);
  for (const k of ["major", "minor", "patch"]) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  // A version without a pre-release ranks above one with it.
  if (!x.prerelease.length || !y.prerelease.length) {
    return y.prerelease.length - x.prerelease.length;
  }
  const n = Math.max(x.prerelease.length, y.prerelease.length);
  for (let i = 0; i < n; i++) {
    const p = x.prerelease[i];
    const q = y.prerelease[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      if (Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1;
    } else if (pn !== qn) {
      return pn ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Turns the `version` input into a bare SemVer, accepting `1.4.0`, `v1.4.0`
 * and `ivaldictl/v1.4.0`. Returns null for `latest`.
 */
export function normalizeVersion(input) {
  const s = String(input ?? "").trim();
  if (s === "" || s.toLowerCase() === "latest") return null;
  const bare = s.replace(/^ivaldictl\//, "").replace(/^v/, "");
  if (!parseSemver(bare)) {
    throw new Error(
      `version '${s}' is not 'latest' or a SemVer such as 1.4.0, v1.4.0 or ivaldictl/v1.4.0`,
    );
  }
  return bare;
}

/** The version a release tag names, or null if it is not an ivaldictl tag. */
export function versionFromTag(tag) {
  if (typeof tag !== "string" || !tag.startsWith(TAG_PREFIX)) return null;
  const v = tag.slice(TAG_PREFIX.length);
  return parseSemver(v) ? v : null;
}

/**
 * Picks the newest ivaldictl release from a list of GitHub releases. Drafts
 * are skipped, and so are pre-releases (by SemVer or by GitHub's flag) unless
 * `prerelease` is set.
 */
export function pickLatest(releases, { prerelease = false } = {}) {
  let best = null;
  for (const r of releases) {
    if (r.draft) continue;
    const v = versionFromTag(r.tag_name);
    if (!v) continue;
    if (!prerelease && (r.prerelease || parseSemver(v).prerelease.length)) continue;
    if (!best || compareSemver(v, best.version) > 0) best = { version: v, release: r };
  }
  return best;
}

/** Maps Node's platform and arch to the names in ivaldictl's archives. */
export function platformTarget(platform, arch) {
  const os = { linux: "linux", darwin: "darwin", win32: "windows" }[platform];
  const goarch = { x64: "amd64", arm64: "arm64" }[arch];
  if (!os || !goarch) {
    throw new Error(
      `ivaldictl is not published for ${platform}/${arch}; it ships for linux, macOS and Windows on x64 and arm64`,
    );
  }
  return { os, arch: goarch };
}

/** The archive and binary names for a version on a platform. */
export function assetNames(version, { os, arch }) {
  const ext = os === "windows" ? "zip" : "tar.gz";
  return {
    archive: `ivaldictl_${version}_${os}_${arch}.${ext}`,
    binary: os === "windows" ? "ivaldictl.exe" : "ivaldictl",
  };
}

/** Parses `sha256sum` output into a map of file name to lowercase hash. */
export function parseChecksums(text) {
  const sums = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(?:\.\/)?(.+?)\s*$/.exec(line);
    if (m) sums.set(m[2], m[1].toLowerCase());
  }
  return sums;
}

/** Parses the `next` URL out of a GitHub `Link` header. */
export function nextPage(link) {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1];
  }
  return null;
}

/** Reads a boolean action input the way @actions/core does. */
export function parseBool(name, value) {
  const s = String(value ?? "").trim();
  if (["true", "True", "TRUE"].includes(s)) return true;
  if (["", "false", "False", "FALSE"].includes(s)) return false;
  throw new Error(`input '${name}' must be true or false, not '${s}'`);
}
