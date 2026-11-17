# setup-ivaldictl

Installs [`ivaldictl`](https://github.com/ivaldibuild/ivaldi/tree/main/apps/cli), the Ivaldi CLI, and points it at your Ivaldi control plane, so later steps can run `ivaldictl release create`, `ivaldictl change record` and the rest.

It downloads the archive for the runner's platform from ivaldictl's GitHub Releases, checks it against the release's `checksums.txt`, keeps it in the runner's tool cache, and puts `ivaldictl` on `PATH`. It runs on Linux, macOS and Windows runners, on x64 and arm64.

## Usage

```yaml
on:
  push:
    tags: ["v*"]

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - id: build
        uses: docker/build-push-action@v6
        with:
          push: true
          tags: ghcr.io/acme/api:${{ github.ref_name }}

      - uses: ivaldibuild/gh-actions/setup-ivaldictl@v1
        with:
          version: 1.4.0
          server-url: https://ivaldi.example.com
          api-token: ${{ secrets.IVALDI_API_TOKEN }}

      - run: ivaldictl release create --app payments-api --artifact "api=${{ steps.build.outputs.digest }}" --publish
```

`server-url` and `api-token` are exported as `IVALDI_SERVER_URL` and `IVALDI_API_TOKEN` for the rest of the job, which is where `ivaldictl` reads them from. The token is masked in logs. If you would rather give the token only to the steps that need it, leave `api-token` out and set `IVALDI_API_TOKEN` in those steps' `env`.

The API token belongs to an Ivaldi service account. An owner or admin creates one, grants it a role (creating and publishing Releases needs `release.manage` and `release.publish`, which admin holds), and issues it a token:

```sh
ivaldictl service-account create --name "GitHub Actions" -o text
ivaldictl api-token create --service-account <service account ID> --name github-actions --expires-in 180d -o text
```

Store the secret it prints once (it starts with `ivt_`) as a repository or organization secret, such as `IVALDI_API_TOKEN`. See [Creating Releases from CI](https://github.com/ivaldibuild/ivaldi/blob/main/docs/self-hosting/ci-releases.md) for granting the role and for what `ivaldictl release create` reads from the workflow.

### Fail early on a bad token

```yaml
      - uses: ivaldibuild/gh-actions/setup-ivaldictl@v1
        with:
          server-url: https://ivaldi.example.com
          api-token: ${{ secrets.IVALDI_API_TOKEN }}
          verify: true
```

`verify` runs `ivaldictl auth status`, so a wrong server URL or an expired or revoked token fails this step instead of a later one.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `version` | `latest` | `1.4.0`, `v1.4.0` or `ivaldictl/v1.4.0`. `latest` is the highest stable version. Pin a version for reproducible builds. |
| `prerelease` | `false` | With `version: latest`, also consider pre-releases such as `1.5.0-rc.1`. |
| `server-url` | | Your control plane's address, exported as `IVALDI_SERVER_URL`. |
| `api-token` | | A service account's API token (`ivt_...`), exported masked as `IVALDI_API_TOKEN`. |
| `verify` | `false` | Run `ivaldictl auth status` after installing. Needs `api-token`. |
| `github-token` | `${{ github.token }}` | Token for reading ivaldictl's GitHub Releases. The releases are public; the token only avoids anonymous rate limits. |
| `repository` | `ivaldibuild/ivaldi` | The repository that publishes ivaldictl releases (`ivaldictl/vX.Y.Z` tags). |
| `github-api-url` | `https://api.github.com` | GitHub API address for `repository`. |

## Outputs

| Output | Description |
| --- | --- |
| `version` | The installed version, such as `1.4.0`. |
| `path` | The directory holding the binary, which is on `PATH`. |
| `cache-hit` | `true` if the binary came from the runner's tool cache. |

## How a version is chosen

- **A pinned version** is the release tagged `ivaldictl/v<version>`. If the runner's tool cache already has it, nothing is downloaded and GitHub is not called.
- **`latest`** is the highest SemVer among published `ivaldictl/v*` releases, not the most recent one, so a patch to an older line never replaces a newer version. Drafts are skipped, and so are pre-releases unless `prerelease: true`.
