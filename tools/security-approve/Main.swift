import Foundation
import LocalAuthentication

// PLACEHOLDERS: replace both through a reviewed source change after provisioning.
let securityAppID = 0
let securityBotUserID = 0

final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) { completionHandler(nil) }
}

@main struct SecurityApprove {
  static func main() async {
    do {
      // Before anything else: only the approver user, at a terminal, from the root-owned path.
      try checkThisProgram(expected: helperPath)
      let args = CommandLine.arguments
      let batch = args.count == 2 && args[1] == "--batch"
      guard batch || args.count == 3 else {
        throw ApprovalError(
          message: "Usage: security-approve --batch | security-approve <pr> <40-hex-sha>")
      }
      let session = URLSession(
        configuration: .ephemeral, delegate: NoRedirects(), delegateQueue: nil)
      defer { session.invalidateAndCancel() }
      let transport: Transport = { method, path, token, body in
        var request = URLRequest(url: URL(string: "https://api.github.com" + path)!)
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        if let token { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        if let body {
          request.httpBody = try json(body)
          request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        return WireResponse(status: (response as? HTTPURLResponse)?.statusCode ?? 0, data: data)
      }
      // The owner authenticates the exact list shown before any key read or signing.
      let confirm: Confirm = { reason in
        let allowed = try await LAContext().evaluatePolicy(
          .deviceOwnerAuthentication, localizedReason: reason)
        guard allowed else { throw ApprovalError(message: "Owner authentication refused") }
      }
      let show: Show = { print($0) }
      let hint: ReviewHint = { reviewHint(pr: $0, sha: $1) }
      let signer: Signer = { try signJWT($0) }
      if batch {
        _ = try await approveBatch(
          queue: try readQueue(), appID: securityAppID, botID: securityBotUserID,
          transport: transport, reviewHint: hint, show: show, confirm: confirm, signer: signer)
      } else {
        print(
          try await approve(
            pr: args[1], sha: args[2], appID: securityAppID, botID: securityBotUserID,
            transport: transport, reviewHint: hint, show: show, confirm: confirm,
            signer: signer))
      }
    } catch let error as ApprovalError {
      FileHandle.standardError.write(Data((error.message + "\n").utf8))
      exit(1)
    } catch {
      FileHandle.standardError.write(
        Data("Approval failed; no credentials or response bodies are logged\n".utf8))
      exit(1)
    }
  }
}
