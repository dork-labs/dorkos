import Darwin
import Foundation

// Reads untrusted, agent-written files and local facts. No Keychain access.

/// Opens without following a symlink and reads a capped regular file.
func readUntrusted(_ path: String, limit: Int) throws -> Data {
  let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
  guard fd >= 0 else { throw ApprovalError(message: "Cannot open \(path)") }
  defer { close(fd) }
  var info = stat()
  guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, Int(info.st_size) <= limit
  else { throw ApprovalError(message: "\(path) is not a small regular file") }
  var data = Data(count: Int(info.st_size))
  let count = data.withUnsafeMutableBytes { read(fd, $0.baseAddress, Int(info.st_size)) }
  guard count == Int(info.st_size) else { throw ApprovalError(message: "Cannot read \(path)") }
  return data
}

func resolvedPath(_ path: String) -> String? {
  guard let pointer = realpath(path, nil) else { return nil }
  defer { free(pointer) }
  return String(cString: pointer)
}

/// The shared inbox must be a real folder at its fixed path, not a symlink elsewhere.
func checkedDirectory(_ path: String) throws -> String {
  guard resolvedPath(path) == path else {
    throw ApprovalError(message: "\(path) is missing or is a link")
  }
  return path
}

func readQueue(directory: String = sharedDirectory) throws -> (entries: [QueueEntry], refused: Int) {
  let root = try checkedDirectory(directory)
  return parseQueue(try readUntrusted(root + "/queue", limit: maxQueueBytes))
}

/// True only if a copied Security review in the shared inbox names this exact SHA.
func reviewed(pr: Int, sha: String, directory: String = sharedDirectory) -> Bool {
  guard let root = try? checkedDirectory(directory + "/reviews"),
    let names = try? FileManager.default.contentsOfDirectory(atPath: root)
  else { return false }
  return names.contains { name in
    guard name.hasPrefix("pr-\(pr)"),
      let contents = try? readUntrusted(root + "/" + name, limit: maxReviewBytes)
    else { return false }
    return reviewNamesSHA(fileName: name, contents: contents, pr: pr, sha: sha)
  }
}

func currentRunner() -> RunnerFacts {
  let uid = getuid()
  let entry = getpwuid(uid)
  return RunnerFacts(
    user: entry.map { String(cString: $0.pointee.pw_name) },
    home: entry.map { String(cString: $0.pointee.pw_dir) },
    uid: uid, euid: geteuid(), stdinIsTerminal: isatty(STDIN_FILENO) == 1)
}

func pathFacts(_ path: String) -> PathFacts? {
  var info = stat()
  guard lstat(path, &info) == 0 else { return nil }
  return PathFacts(
    owner: info.st_uid, mode: UInt16(info.st_mode & 0o7777),
    isSymlink: info.st_mode & S_IFMT == S_IFLNK)
}

/// Refuses unless this program runs as the approver, from its pinned root-owned path.
func checkThisProgram(expected: String) throws {
  try checkRunner(currentRunner())
  var size: UInt32 = 0
  _ = _NSGetExecutablePath(nil, &size)
  var buffer = [CChar](repeating: 0, count: Int(size) + 1)
  guard _NSGetExecutablePath(&buffer, &size) == 0 else {
    throw ApprovalError(message: "Cannot find this program's path")
  }
  let executable = String(cString: buffer)
  try checkInstall(
    executable: executable, resolved: resolvedPath(executable) ?? "", expected: expected,
    facts: pathFacts)
}
