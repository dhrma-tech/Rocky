# Homebrew cask for the Apple Silicon build (the release runner is macos-latest, arm64).
cask "rocky" do
  version "{{VERSION}}"
  sha256 "{{SHA256:Rocky-{{VERSION}}-arm64.dmg}}"

  url "https://github.com/dhrma-tech/Rocky/releases/download/v#{version}/Rocky-#{version}-arm64.dmg"
  name "Rocky"
  desc "Local-first memory and approval layer"
  homepage "https://github.com/dhrma-tech/Rocky"

  depends_on arch: :arm64

  app "Rocky.app"
end
