import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

enum CaptureError: Error, CustomStringConvertible {
    case usage
    case unsupportedOS
    case noDisplay
    case noImageDestination
    case pngWriteFailed
    case selfTestUnavailable

    var description: String {
        switch self {
        case .usage: return "Usage: mds-capture <full|left|right> <png-path> <overlay-pid> <window-ids>"
        case .unsupportedOS: return "ScreenCaptureKit screenshots require macOS 14 or later."
        case .noDisplay: return "The main display is unavailable to ScreenCaptureKit."
        case .noImageDestination: return "Could not create a PNG image destination."
        case .pngWriteFailed: return "Could not write the captured PNG."
        case .selfTestUnavailable: return "Overlay capture self-test could not identify the visible overlay."
        }
    }
}

@main
struct CaptureAgent {
    static func main() async {
        do {
            if CommandLine.arguments.count == 4, CommandLine.arguments[1] == "self-test",
               let overlayPID = Int32(CommandLine.arguments[2]) {
                guard #available(macOS 14.0, *) else { throw CaptureError.unsupportedOS }
                let ids = Set(CommandLine.arguments[3].split(separator: ",").compactMap { UInt32($0) })
                let visible = try await selfTest(overlayPID: overlayPID, overlayWindowIDs: ids)
                if visible {
                    FileHandle.standardError.write(Data("Overlay pixels may be present in an unfiltered ScreenCaptureKit screenshot.\n".utf8))
                    exit(10)
                }
                return
            }
            guard CommandLine.arguments.count == 5,
                  ["full", "left", "right"].contains(CommandLine.arguments[1]),
                  let overlayPID = Int32(CommandLine.arguments[3]) else {
                throw CaptureError.usage
            }
            guard #available(macOS 14.0, *) else { throw CaptureError.unsupportedOS }
            let ids = Set(CommandLine.arguments[4].split(separator: ",").compactMap { UInt32($0) })
            try await capture(
                mode: CommandLine.arguments[1],
                destination: URL(fileURLWithPath: CommandLine.arguments[2]),
                overlayPID: overlayPID,
                overlayWindowIDs: ids
            )
        } catch {
            FileHandle.standardError.write(Data("\(error)\n".utf8))
            if case CaptureError.unsupportedOS = error { exit(78) }
            exit(1)
        }
    }

    @available(macOS 14.0, *)
    private static func selfTest(overlayPID: Int32, overlayWindowIDs: Set<UInt32>) async throws -> Bool {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let ownApp = content.applications.first(where: { $0.processID == overlayPID }) else {
            throw CaptureError.selfTestUnavailable
        }
        let windowInfo = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
        let bounds = windowInfo.compactMap { entry -> CGRect? in
            guard let number = entry[kCGWindowNumber as String] as? UInt32,
                  overlayWindowIDs.contains(number),
                  let dictionary = entry[kCGWindowBounds as String] as? [String: Any] else { return nil }
            return CGRect(dictionaryRepresentation: dictionary as CFDictionary)
        }
        guard !bounds.isEmpty else { throw CaptureError.selfTestUnavailable }
        guard let display = content.displays.max(by: { lhs, rhs in
            let lhsArea = bounds.reduce(CGFloat.zero) { area, rect in
                let overlap = rect.intersection(lhs.frame)
                return area + max(overlap.width, 0) * max(overlap.height, 0)
            }
            let rhsArea = bounds.reduce(CGFloat.zero) { area, rect in
                let overlap = rect.intersection(rhs.frame)
                return area + max(overlap.width, 0) * max(overlap.height, 0)
            }
            return lhsArea < rhsArea
        }) else { throw CaptureError.selfTestUnavailable }

        let config = SCStreamConfiguration()
        let scale = max(CGFloat(display.width) / display.frame.width, 1)
        config.width = Int((display.frame.width * scale).rounded())
        config.height = Int((display.frame.height * scale).rounded())
        config.showsCursor = false
        config.capturesAudio = false
        let unfiltered = SCContentFilter(display: display, excludingWindows: [])
        let excluded = SCContentFilter(display: display, excludingApplications: [ownApp], exceptingWindows: [])
        let first = try await SCScreenshotManager.captureImage(contentFilter: unfiltered, configuration: config)
        let second = try await SCScreenshotManager.captureImage(contentFilter: excluded, configuration: config)
        return try imagesDifferInWindowBounds(first, second, bounds: bounds, displayFrame: display.frame)
    }

    private static func imagesDifferInWindowBounds(
        _ first: CGImage, _ second: CGImage, bounds: [CGRect], displayFrame: CGRect
    ) throws -> Bool {
        guard first.width == second.width, first.height == second.height,
              displayFrame.width > 0, displayFrame.height > 0 else { throw CaptureError.selfTestUnavailable }
        let width = first.width
        let height = first.height
        let bytesPerRow = width * 4
        func pixels(_ image: CGImage) -> [UInt8]? {
            var buffer = [UInt8](repeating: 0, count: bytesPerRow * height)
            let drawn = buffer.withUnsafeMutableBytes { bytes -> Bool in
                guard let base = bytes.baseAddress,
                      let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
                      let context = CGContext(data: base, width: width, height: height,
                                              bitsPerComponent: 8, bytesPerRow: bytesPerRow,
                                              space: colorSpace,
                                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue |
                                                  CGBitmapInfo.byteOrder32Big.rawValue) else { return false }
                context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
                return true
            }
            return drawn ? buffer : nil
        }
        guard let a = pixels(first), let b = pixels(second) else { throw CaptureError.selfTestUnavailable }
        let xScale = CGFloat(width) / displayFrame.width
        let yScale = CGFloat(height) / displayFrame.height
        var checked = 0
        var changed = 0
        for rect in bounds {
            let x0 = max(0, Int(((rect.minX - displayFrame.minX) * xScale).rounded(.down)))
            let x1 = min(width, Int(((rect.maxX - displayFrame.minX) * xScale).rounded(.up)))
            // CGWindow bounds use a top-left origin; bitmap rows start at the bottom.
            let y0 = max(0, Int(((displayFrame.maxY - rect.maxY) * yScale).rounded(.down)))
            let y1 = min(height, Int(((displayFrame.maxY - rect.minY) * yScale).rounded(.up)))
            guard x0 < x1, y0 < y1 else { continue }
            for y in stride(from: y0, to: y1, by: 4) {
                for x in stride(from: x0, to: x1, by: 4) {
                    let i = y * bytesPerRow + x * 4
                    checked += 1
                    if (0..<3).contains(where: { abs(Int(a[i + $0]) - Int(b[i + $0])) > 35 }) {
                        changed += 1
                    }
                }
            }
        }
        guard checked > 0 else { throw CaptureError.selfTestUnavailable }
        // A substantial difference in the overlay's bounds suggests it was included.
        // Motion underneath the overlay can also differ between the two captures.
        return changed * 100 > checked * 2
    }

    @available(macOS 14.0, *)
    private static func capture(
        mode: String,
        destination: URL,
        overlayPID: Int32,
        overlayWindowIDs: Set<UInt32>
    ) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) else {
            throw CaptureError.noDisplay
        }

        let ownWindows = content.windows.filter { overlayWindowIDs.contains($0.windowID) }
        let filter: SCContentFilter
        if !ownWindows.isEmpty && ownWindows.count == overlayWindowIDs.count {
            filter = SCContentFilter(display: display, excludingWindows: ownWindows)
        } else if let ownApp = content.applications.first(where: { $0.processID == overlayPID }) {
            // Protected or hidden overlay windows might not be shareable as SCWindow objects.
            filter = SCContentFilter(display: display, excludingApplications: [ownApp], exceptingWindows: [])
        } else {
            // The caller hides the overlay before starting capture, so it cannot enter the image.
            filter = SCContentFilter(display: display, excludingWindows: ownWindows)
        }

        let config = SCStreamConfiguration()
        let scale = max(CGFloat(filter.pointPixelScale), 1)
        let width = CGFloat(display.width)
        let height = CGFloat(display.height)
        let leftWidth = floor(width / 2)
        switch mode {
        case "left":
            config.sourceRect = CGRect(x: 0, y: 0, width: leftWidth, height: height)
            config.width = Int((leftWidth * scale).rounded())
        case "right":
            config.sourceRect = CGRect(x: leftWidth, y: 0, width: width - leftWidth, height: height)
            config.width = Int(((width - leftWidth) * scale).rounded())
        default:
            config.width = Int((width * scale).rounded())
        }
        config.height = Int((height * scale).rounded())
        config.showsCursor = false
        config.capturesAudio = false

        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        guard let writer = CGImageDestinationCreateWithURL(destination as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            throw CaptureError.noImageDestination
        }
        CGImageDestinationAddImage(writer, image, nil)
        guard CGImageDestinationFinalize(writer) else { throw CaptureError.pngWriteFailed }
    }
}
