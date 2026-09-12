#!/usr/bin/env bash
set -euo pipefail

# Check if the overlay window appears in CGWindowList.
swift - <<'EOF'
import CoreGraphics

let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
let windows = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as! [[String: Any]]

for w in windows {
  let name = w[kCGWindowName as String] as? String ?? "unnamed"
  let owner = w[kCGWindowOwnerName as String] as? String ?? "?"
  let layer = w[kCGWindowLayer as String] as? Int ?? -1
  let sharing = w[kCGWindowSharingState as String] as? Int ?? -1

  if name.lowercased().contains("overlay")
    || owner.lowercased().contains("council")
    || owner.lowercased().contains("corespotlight") {
    print("FOUND: owner=\(owner) | layer=\(layer) | sharing=\(sharing) | name=\(name)")
  }
}

print("Check complete. If nothing printed above, overlay is invisible to CGWindowList.")
EOF
