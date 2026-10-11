# Package manager manifests

Templates for winget, Scoop and Homebrew (roadmap A1). They point at the installers that
`.github/workflows/release.yml` attaches to a GitHub release. After a release is published:

```
node packaging/fill.ts v0.1.0 path/to/SHA256SUMS.txt
```

writes filled copies to `packaging/out/`. Submitting them (a PR to `microsoft/winget-pkgs`,
a Scoop bucket, a Homebrew tap) is a manual step for a maintainer. Nothing here publishes.

Not yet tested against a real release: the first one will show whether each manager accepts them
(`winget validate`, `scoop install ./rocky.json`, `brew install --cask ./rocky.rb`).
