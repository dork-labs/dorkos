#include "ExactAccess.h"
#include <dlfcn.h>
#include <string.h>
// Apple exports this SPI but does not declare it in the public SDK. Missing
// support is a refusal, never a fallback to a broad designated requirement.
typedef OSStatus (*FromRequirement)(const char *, SecRequirementRef, SecTrustedApplicationRef *);
OSStatus DorkExactAccess(const char *path, const char *hash, SecAccessRef *access) {
    *access = NULL;
    if (strlen(hash) != 40 || strspn(hash, "0123456789abcdef") != 40) return errSecParam;
    FromRequirement create = (FromRequirement)dlsym(RTLD_DEFAULT, "SecTrustedApplicationCreateFromRequirement");
    if (!create) return errSecUnimplemented;
    CFStringRef text = CFStringCreateWithFormat(NULL, NULL, CFSTR("cdhash H\"%s\""), hash);
    SecRequirementRef requirement = NULL; SecStaticCodeRef code = NULL; SecTrustedApplicationRef trusted = NULL;
    CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL, (const UInt8 *)path, strlen(path), false);
    OSStatus status = SecRequirementCreateWithString(text, 0, &requirement);
    if (!status) status = SecStaticCodeCreateWithPath(url, 0, &code);
    if (!status) status = SecStaticCodeCheckValidity(code, kSecCSStrictValidate, requirement);
    if (!status) status = create(path, requirement, &trusted);
    if (!status) {
        const void *values[] = { trusted };
        CFArrayRef applications = CFArrayCreate(NULL, values, 1, &kCFTypeArrayCallBacks);
        status = SecAccessCreate(CFSTR("DorkOS Security Review exact helper cdhash"), applications, access);
        CFRelease(applications);
    }
    if (trusted) CFRelease(trusted); if (code) CFRelease(code); if (requirement) CFRelease(requirement);
    CFRelease(text); CFRelease(url); return status;
}
