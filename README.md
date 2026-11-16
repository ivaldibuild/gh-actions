# Ivaldi GitHub Actions

Public GitHub Actions for using [Ivaldi](https://github.com/ivaldibuild) from your workflows.

| Action | Description |
| --- | --- |
| [`setup-ivaldictl`](setup-ivaldictl) | Install the `ivaldictl` CLI and point it at your Ivaldi control plane. |

```yaml
- uses: ivaldibuild/gh-actions/setup-ivaldictl@v1
  with:
    server-url: https://ivaldi.example.com
    api-token: ${{ secrets.IVALDI_API_TOKEN }}
```

## Versioning

The actions are released together, from tags on this repository:

- `vX.Y.Z` tags never move. Pin one, or its commit SHA, for fully reproducible workflows.
- `vX` moves to the newest `vX.Y.Z`. It receives fixes and additions, never breaking changes to inputs or outputs.

## Development

Each action lives in its own directory with its `action.yml`. The actions are dependency-free JavaScript run by the runner's Node, so there is no build step and no `dist/` to keep in sync.

```sh
node --test setup-ivaldictl/test/*.test.mjs
```
