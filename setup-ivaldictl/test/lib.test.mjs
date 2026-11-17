import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assetNames,
  compareSemver,
  nextPage,
  normalizeVersion,
  parseBool,
  parseChecksums,
  pickLatest,
  platformTarget,
  versionFromTag,
} from "../src/lib.mjs";

test("compareSemver follows SemVer precedence", () => {
  const ordered = [
    "0.9.0",
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0-rc-1",
    "1.0.0-rc-2",
    "1.0.0",
    "1.0.1",
    "1.2.0",
    "1.10.0",
    "2.0.0",
  ];
  for (let i = 0; i < ordered.length - 1; i++) {
    assert.equal(compareSemver(ordered[i], ordered[i + 1]), -1, `${ordered[i]} < ${ordered[i + 1]}`);
    assert.equal(compareSemver(ordered[i + 1], ordered[i]), 1, `${ordered[i + 1]} > ${ordered[i]}`);
  }
  assert.equal(compareSemver("1.0.0+build.1", "1.0.0"), 0);
});

test("normalizeVersion accepts the forms a tag takes", () => {
  assert.equal(normalizeVersion("latest"), null);
  assert.equal(normalizeVersion(""), null);
  assert.equal(normalizeVersion(" LATEST "), null);
  assert.equal(normalizeVersion("1.4.0"), "1.4.0");
  assert.equal(normalizeVersion("v1.4.0"), "1.4.0");
  assert.equal(normalizeVersion("ivaldictl/v1.0.0-rc-2"), "1.0.0-rc-2");
  assert.throws(() => normalizeVersion("1.4"), /not 'latest' or a SemVer/);
  assert.throws(() => normalizeVersion("ivaldi/v1.4.0"), /not 'latest' or a SemVer/);
});

test("versionFromTag only takes ivaldictl tags", () => {
  assert.equal(versionFromTag("ivaldictl/v1.2.3"), "1.2.3");
  assert.equal(versionFromTag("ivaldi/v1.2.3"), null);
  assert.equal(versionFromTag("ivaldi-k8s-agent/v1.2.3"), null);
  assert.equal(versionFromTag("ivaldictl/vnext"), null);
});

test("pickLatest picks the highest version, not the newest release", () => {
  const releases = [
    { tag_name: "ivaldi/v9.0.0", draft: false, prerelease: false },
    { tag_name: "ivaldictl/v1.1.1", draft: false, prerelease: false }, // patch to an older line, released last
    { tag_name: "ivaldictl/v1.3.0-rc.1", draft: false, prerelease: false },
    { tag_name: "ivaldictl/v1.2.0", draft: false, prerelease: false },
    { tag_name: "ivaldictl/v1.4.0", draft: true, prerelease: false },
    { tag_name: "ivaldictl/v1.2.5", draft: false, prerelease: true }, // GitHub says pre-release
  ];
  assert.equal(pickLatest(releases).version, "1.2.0");
  assert.equal(pickLatest(releases, { prerelease: true }).version, "1.3.0-rc.1");
  assert.equal(pickLatest([{ tag_name: "ivaldictl/v1.0.0-rc-2", draft: false, prerelease: false }]), null);
  assert.equal(pickLatest([]), null);
});

test("platformTarget maps runners to archive names", () => {
  assert.deepEqual(platformTarget("linux", "x64"), { os: "linux", arch: "amd64" });
  assert.deepEqual(platformTarget("darwin", "arm64"), { os: "darwin", arch: "arm64" });
  assert.deepEqual(platformTarget("win32", "x64"), { os: "windows", arch: "amd64" });
  assert.throws(() => platformTarget("linux", "ia32"), /not published for linux\/ia32/);
  assert.throws(() => platformTarget("freebsd", "x64"), /not published/);
});

test("assetNames matches scripts/build-cli-release.sh", () => {
  assert.deepEqual(assetNames("1.0.0", { os: "linux", arch: "amd64" }), {
    archive: "ivaldictl_1.0.0_linux_amd64.tar.gz",
    binary: "ivaldictl",
  });
  assert.deepEqual(assetNames("1.0.0-rc-2", { os: "windows", arch: "arm64" }), {
    archive: "ivaldictl_1.0.0-rc-2_windows_arm64.zip",
    binary: "ivaldictl.exe",
  });
});

test("parseChecksums reads sha256sum output", () => {
  const a = "a".repeat(64);
  const b = "B".repeat(64);
  const c = "c".repeat(64);
  const sums = parseChecksums(
    `${a}  ./ivaldictl_1.0.0_linux_amd64.tar.gz\r\n${b} *ivaldictl_1.0.0_windows_amd64.zip\n${c}  plain.txt\n\nnot a line\n`,
  );
  assert.equal(sums.get("ivaldictl_1.0.0_linux_amd64.tar.gz"), a);
  assert.equal(sums.get("ivaldictl_1.0.0_windows_amd64.zip"), "b".repeat(64));
  assert.equal(sums.get("plain.txt"), c);
  assert.equal(sums.size, 3);
});

test("nextPage reads the Link header", () => {
  assert.equal(
    nextPage('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"'),
    "https://api.github.com/x?page=2",
  );
  assert.equal(nextPage('<https://api.github.com/x?page=1>; rel="prev"'), null);
  assert.equal(nextPage(null), null);
});

test("parseBool", () => {
  assert.equal(parseBool("x", "true"), true);
  assert.equal(parseBool("x", "FALSE"), false);
  assert.equal(parseBool("x", ""), false);
  assert.throws(() => parseBool("x", "yes"), /input 'x' must be true or false/);
});
