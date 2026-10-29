// CI macOS runner only, invoked by the guarded test-keychain.sh.
import Foundation

@main struct RealPolicyProbe {
  static func main() {
    guard ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true",
      ProcessInfo.processInfo.environment["RUNNER_OS"] == "macOS",
      CommandLine.arguments.count == 3
    else { exit(2) }
    do {
      try validateHelperSignature(
        path: CommandLine.arguments[1], expectedHash: CommandLine.arguments[2])
    } catch { exit(1) }
  }
}
