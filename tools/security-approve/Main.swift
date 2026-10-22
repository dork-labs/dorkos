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
      let args = CommandLine.arguments
      guard args.count == 3 else {
        throw ApprovalError(message: "Usage: security-approve <pr> <40-hex-sha>")
      }
      let session = URLSession(
        configuration: .ephemeral, delegate: NoRedirects(), delegateQueue: nil)
      defer { session.invalidateAndCancel() }
      let result = try await approve(
        pr: args[1], sha: args[2], appID: securityAppID,
        botID: securityBotUserID,
        transport: { path, token, body in
          var request = URLRequest(url: URL(string: "https://api.github.com" + path)!)
          request.timeoutInterval = 30
          request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
          request.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
          if let token { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
          if let body {
            request.httpMethod = "POST"
            request.httpBody = try json(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
          }
          let (data, response) = try await session.data(for: request)
          return WireResponse(status: (response as? HTTPURLResponse)?.statusCode ?? 0, data: data)
        },
        signer: { payload in
          // The approved binary is callable by agents too. Require the owner
          // to authenticate this exact PR/SHA before any key read/signing.
          let context = LAContext()
          let allowed = try await context.evaluatePolicy(
            .deviceOwnerAuthentication,
            localizedReason: "Approve dork-labs/dorkos PR #\(args[1]) at \(args[2])")
          guard allowed else { throw ApprovalError(message: "Owner authentication refused") }
          return try signJWT(payload)
        })
      print(result)
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
