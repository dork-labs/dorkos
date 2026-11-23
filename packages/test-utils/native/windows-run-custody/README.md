# Windows run custody helper

This directory is reserved for the source-owned Windows test helper in [DOR-4500](../../../../specs/opencode-run-custody/02-specification.md#9-windows-eligibility-backend-and-distribution). The private guardian, source-build command and prepared-artifact verifier are available for Windows validation.

The explicit build prepares a separate helper under `dist/<architecture>/` for each of `x64`, `arm64` and `ia32`. Each ignored output directory contains `windows-run-custody.exe` and `windows-run-custody.json`. Build intermediates stay outside that directory. The resolver uses the Darwin reader's 8 KiB manifest and 8 MiB file limits.

The manifest records these fields.

| Field                        | Expected value                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `origin`                     | `packages/test-utils/native/windows-run-custody`                                                     |
| `protocolVersion`            | The protocol version the helper actually implements                                                  |
| `architecture` and `machine` | The Node architecture name and the numeric PE machine field for the built executable                 |
| `sourceSha256`               | A map from each compiled source and authored header's path relative to this directory to its SHA-256 |
| `compiler` and `sdk`         | The observed compiler and SDK version strings                                                        |
| `artifactSha256`             | SHA-256 of the executable bytes                                                                      |

The owner supplies the selected manifest's SHA-256 and the builder's explicit source and header list independently of the manifest file. The caller selects the helper architecture from Node's `process.arch`. The resolver reads the listed inputs from this source tree and selects the artifact relative to its own module. Missing or stale files fail before launch. The build and launch steps still owe native Windows evidence for the supported architectures and caller paths.

`owned-job.c` prepares the guardian's Job before any target is created. [The Windows witness](tests/owned-job-witness.c) calls this constructor, checks the returned handle's inheritance flag, and queries the limits and accounting of that exact Job. It exits zero after confirming the close-time cleanup flag is the only limit set, the Job has never contained a process, and the handle closes. [Microsoft handle information](https://learn.microsoft.com/en-us/windows/win32/api/handleapi/nf-handleapi-gethandleinformation) · [Microsoft Job queries](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject)

Build the witness from a scratch output directory in the intended VS 2022 target environment. Set `$source` to the absolute path of this source directory.

```powershell
cl /nologo /TC /std:c11 /W4 /WX /MT /D_WIN32_WINNT=0x0a00 "$source\owned-job.c" "$source\tests\owned-job-witness.c" /Feowned-job-witness.exe /link Kernel32.lib
if ($LASTEXITCODE -ne 0) { throw "Owned Job witness build failed" }
.\owned-job-witness.exe
if ($LASTEXITCODE -ne 0) { throw "Owned Job witness failed" }
```

Keep the compiler and SDK versions, target architecture, and exit status with the Windows run. The eventual guardian keeps the handle in its own process and uses it for creation-time membership. An independent observer still has to prove last-handle cleanup with live owned processes.

## Guardian lifetime witness

The private guardian lifetime takes ownership of a suspended target and its Job after admission. It checks the actual process, thread and image, confirms both owners, and posts separate reads on the two owner pipes before resuming. Both reads stay active while the direct target or any descendant is alive. A closed owner pipe starts Job termination and a bounded join. A normal exit requires both the exact target handle to signal and the Job's active process count to reach zero. [Microsoft overlapped pipe I/O](https://learn.microsoft.com/en-us/windows/win32/ipc/synchronous-and-overlapped-input-and-output) · [Microsoft Job accounting](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information)

The maintained witness exercises the ordinary exit, refused admission, each owner leaving before and after resume, and main-owner loss with a live descendant. The descendant reports startup after observing the exact leader handle signal. The guardian keeps the Job through its zero-member observation. The witness separately retains the direct target handle and waits for both owner peers and the native process to close. Run from a scratch output directory in the target VS 2022 environment, with `$source` set as above.

```powershell
cl /nologo /TC /std:c11 /W4 /WX /MT /D_WIN32_WINNT=0x0a00 "$source\owned-job.c" "$source\suspended-target.c" "$source\owner-pipe.c" "$source\owner-attempt.c" "$source\guardian-io.c" "$source\guardian-lifetime.c" "$source\tests\owner-attempt-witness.c" /Feowner-attempt-witness.exe /link Kernel32.lib Advapi32.lib Bcrypt.lib
if ($LASTEXITCODE -ne 0) { throw "Guardian lifetime witness build failed" }
node --test "$source\tests\owner-attempt-witness.mjs"
if ($LASTEXITCODE -ne 0) { throw "Guardian lifetime witness failed" }
```

The Windows acceptance run also needs an independent descendant observation across guardian exit, Job and handle negative controls, and the real caller matrix.

## Private guardian launcher witness

`guardian.c` pairs with the private Node launcher. The guardian receives one bounded activation request over an inherited overlapped control pipe. The two owners connect independently and authenticate each attempt. The actual target receives only its requested standard streams, separate from the guardian's stop and report pipes. The guardian reports readiness, positively observed native identity after resume, and separate operation and cleanup results after shutdown. The parent requires a consistent native terminal record and the guardian's own exit. The launcher sends immediate Job cleanup after the caller's existing stop route or grace period. [Node child-process stdio](https://github.com/nodejs/node/blob/v24.19.0/doc/api/child_process.md#optionsstdio) · [Microsoft explicit handle inheritance](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)

Run the Windows launcher witness from a scratch output directory in the intended VS 2022 environment.

```powershell
cl /nologo /TC /std:c11 /W4 /WX /MT /D_WIN32_WINNT=0x0a00 "$source\owned-job.c" "$source\suspended-target.c" "$source\owner-pipe.c" "$source\owner-attempt.c" "$source\guardian-io.c" "$source\guardian-lifetime.c" "$source\guardian.c" /Fewindows-guardian-witness.exe /link Kernel32.lib Advapi32.lib Bcrypt.lib
if ($LASTEXITCODE -ne 0) { throw "Private guardian witness build failed" }
node --test "$source\tests\guardian-launcher-witness.mjs"
if ($LASTEXITCODE -ne 0) { throw "Private guardian witness failed" }
```

This scratch test covers separate input and output, a native create refusal, immediate stop during admission, and stop after an observed native start with both owners still live. Windows caller selection awaits native review and evidence.

## Source-built private artifacts

From an x64 Node process on Windows, run `pnpm --filter @dorkos/test-utils build:run-custody:windows`. The command discovers the installed VS 2022 tools through Microsoft's locator. It uses v143 14.44 and SDK 10.0.26100.0, including the x64/x86 and ARM64 compiler components. It compiles the same explicit set of sources for x64, arm64 and ia32 with the static C runtime, verifies each PE and writes its binary and manifest. The command prints the separate manifest and artifact SHA-256 for each target. Preserve those values from the build that will be selected. [Microsoft command-line Build Tools](https://learn.microsoft.com/en-us/cpp/build/building-on-the-command-line?view=msvc-170#vcvarsall-syntax)

The build uses an isolated scratch folder and publishes the three outputs together. It keeps the prior prepared build if a compile or verification step fails. The source bytes are pinned to LF to keep the source hashes exact across checkouts. No build happens on install or lookup. The portable tests exercise input enumeration and metadata. Compiling and running the native witnesses on their intended Windows architectures is required before selecting the helper in a caller.

## Opt-in native witness receipt

Run the witness coordinator on the intended Windows architecture after preparing the package build. Pass the manifest digest captured by the build for that architecture.

```powershell
node packages/test-utils/native/windows-run-custody/tests/run-windows-witnesses.mjs --manifest-sha256 $manifestSha256
```

The coordinator verifies the selected guardian and runs its exact bytes. It builds the separate lifetime fixture through the same installed VS toolchain. The fixture reads its actual process and host architecture from Windows. Native x64 and ARM64 require the matching Windows host. Node 22 ia32 on x64 Windows records process-only coverage. The Windows architecture API is required. Hosts using the local companion-build path also need the pinned x64-host tools. [Microsoft process architecture API](https://learn.microsoft.com/en-us/windows/win32/api/wow64apiset/nf-wow64apiset-iswow64process2)

The eleven cases run serially against owned local fixture processes. The ignored `.build-witness-*` folder contains the per-case receipt, raw test event feed and compiler, process architecture and test logs. The receipt requires actual native process or refusal facts and the matching tested case result. Missing, skipped or failed cases leave the receipt incomplete. The runner covers these eleven maintained witnesses. Real OpenCode calls and the separate Windows acceptance cases still need their own evidence.

### Prepared ARM64 companion

On the x64 Windows build host, prepare the existing ARM64 guardian and use its captured manifest digest to cross-build the companion.

```powershell
node packages/test-utils/native/windows-run-custody/tests/prepare-arm64-witness-companion.mjs --guardian-manifest-sha256 $guardianManifestSha256
```

Transfer the two ARM64 guardian files and the separately reported companion `handoff` directory from the same reviewed checkout. Preserve both manifest digests independently of the transferred files. Place the guardian in the normal private ARM64 artifact location. On a native Windows ARM64 host, run the existing coordinator with native Node and both selections.

```powershell
node packages/test-utils/native/windows-run-custody/tests/run-windows-witnesses.mjs --manifest-sha256 $guardianManifestSha256 --companion-directory $companionDirectory --companion-manifest-sha256 $companionManifestSha256
```

The companion directory must be an absolute local path containing its exact executable and manifest. The producer records the compiler, SDK and source hashes. The consumer verifies both builds before invoking the native probe and the same eleven cases. Copy the producer compiler logs and consumer runtime receipt separately. The prepared mode is specific to ARM64. The x64 and eligible ia32 commands continue to compile their witness locally.
