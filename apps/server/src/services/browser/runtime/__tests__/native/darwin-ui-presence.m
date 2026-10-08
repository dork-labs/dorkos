// Fixture-only AppKit/AX observer. No production authority, preference writes, titles or screen pixels.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <signal.h>
#include <sys/proc.h>
#include <limits.h>
#include <unistd.h>

static NSDictionary *identity(pid_t pid) {
  struct proc_bsdinfo first = {0}, second = {0};
  if (pid <= 0 || proc_pidinfo(pid, PROC_PIDTBSDINFO, 1, &first, sizeof(first)) != sizeof(first) ||
      proc_pidinfo(pid, PROC_PIDTBSDINFO, 1, &second, sizeof(second)) != sizeof(second) ||
      first.pbi_pid != pid || second.pbi_pid != pid || first.pbi_status == SZOMB || second.pbi_status == SZOMB ||
      first.pbi_start_tvsec != second.pbi_start_tvsec || first.pbi_start_tvusec != second.pbi_start_tvusec ||
      !first.pbi_start_tvsec || first.pbi_start_tvusec >= 1000000) return nil;
  return @{ @"pid": @(pid), @"birth": [NSString stringWithFormat:@"darwin-bsd-start:%llu:%llu", (unsigned long long)first.pbi_start_tvsec, (unsigned long long)first.pbi_start_tvusec] };
}
static BOOL current(NSDictionary *original) {
  return [identity([original[@"pid"] intValue]) isEqual:original];
}
static NSString *executable(pid_t pid) {
  char bytes[PROC_PIDPATHINFO_MAXSIZE] = {0};
  if (proc_pidpath(pid, bytes, sizeof(bytes)) <= 0) return nil;
  return [[NSString stringWithUTF8String:bytes] stringByResolvingSymlinksInPath];
}
static void emit(NSDictionary *row) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:row options:0 error:nil];
  if (!data || data.length > 65536) { fputs("UI_OBSERVATION_OUTPUT_UNKNOWN\n", stderr); exit(1); }
  fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout); fflush(stdout);
}
static id attribute(AXUIElementRef element, CFStringRef name, BOOL *complete) {
  CFTypeRef value = NULL;
  AXError result = AXUIElementCopyAttributeValue(element, name, &value);
  if (result != kAXErrorSuccess) { *complete = NO; return nil; }
  return CFBridgingRelease(value);
}
typedef struct { int interference; int unknown; unsigned long long tag; unsigned int releases; } ProbeState;
static CGEventRef observe_probe(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *context) {
  ProbeState *state = context;
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) { state->unknown = 1; return event; }
  if ((unsigned long long)CGEventGetIntegerValueField(event, kCGEventSourceUserData) != state->tag) { state->interference++; return event; }
  // Keycodes are inspected only on our own tagged original events, never operator input.
  if (type == kCGEventKeyUp) {
    long long code = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
    if (code == 53) state->releases |= 1;
    if (code == 48) state->releases |= 2;
    if (code == 55) state->releases |= 4;
  }
  if (type == kCGEventFlagsChanged && !(CGEventGetFlags(event) & kCGEventFlagMaskCommand)) state->releases |= 4;
  return event;
}
@interface PresenceObserver : NSObject
@property (nonatomic, strong) NSWindow *window;
@property (nonatomic) BOOL interaction;
@property (nonatomic, copy) NSArray<NSDictionary *> *targets;
@property (nonatomic, strong) NSMutableArray<NSDictionary *> *activations;
@property (nonatomic, strong) id activationObserver;
@property (nonatomic) BOOL activationOverflow;
@end
@implementation PresenceObserver
- (instancetype)init {
  if ((self = [super init])) {
    _targets = @[]; _activations = [NSMutableArray array];
    __weak PresenceObserver *weak = self;
    _activationObserver = [NSWorkspace.sharedWorkspace.notificationCenter addObserverForName:NSWorkspaceDidActivateApplicationNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *notification) {
      PresenceObserver *owner = weak;
      if (!owner) return;
      NSRunningApplication *application = notification.userInfo[NSWorkspaceApplicationKey];
      NSDictionary *fact = identity(application.processIdentifier);
      // Retain only numeric original process evidence, never app/window names or contents.
      if (owner.activations.count < 512) [owner.activations addObject:fact ?: @{ @"unknown": @YES }];
      else owner.activationOverflow = YES;
    }];
  } return self;
}
- (NSArray<NSDictionary *> *)dockTree:(BOOL *)complete {
  *complete = AXIsProcessTrusted();
  if (!*complete) return @[];
  NSArray *docks = [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.apple.dock"];
  if (docks.count != 1) { *complete = NO; return @[]; }
  NSRunningApplication *dock = docks[0];
  NSDictionary *original = identity(dock.processIdentifier);
  if (!original) { *complete = NO; return @[]; }
  AXUIElementRef root = AXUIElementCreateApplication(dock.processIdentifier);
  AXUIElementSetMessagingTimeout(root, 0.25);
  NSMutableArray *todo = [NSMutableArray arrayWithObject:(__bridge id)root];
  NSMutableArray *rows = [NSMutableArray array];
  NSHashTable *seen = [NSHashTable hashTableWithOptions:NSPointerFunctionsStrongMemory | NSPointerFunctionsObjectPointerPersonality];
  const NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + 1.0;
  while (todo.count) {
    if (NSProcessInfo.processInfo.systemUptime >= deadline) { *complete = NO; break; }
    if (seen.count >= 512) { *complete = NO; break; }
    id object = todo.lastObject; [todo removeLastObject];
    if ([seen containsObject:object]) { *complete = NO; break; } [seen addObject:object];
    AXUIElementRef element = (__bridge AXUIElementRef)object;
    AXUIElementSetMessagingTimeout(element, 0.05);
    BOOL readable = YES;
    NSString *role = attribute(element, kAXRoleAttribute, &readable);
    if (![role isKindOfClass:NSString.class]) { *complete = NO; continue; }
    CFTypeRef raw = NULL;
    AXError childResult = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &raw);
    NSArray *children = raw ? CFBridgingRelease(raw) : nil;
    if (childResult != kAXErrorSuccess && childResult != kAXErrorAttributeUnsupported) *complete = NO;
    if (children && ![children isKindOfClass:NSArray.class]) { *complete = NO; continue; }
    if (children.count + todo.count + seen.count > 512) { *complete = NO; break; }
    if (children) [todo addObjectsFromArray:children];
    CFTypeRef subroleValue = NULL;
    AXUIElementCopyAttributeValue(element, kAXSubroleAttribute, &subroleValue);
    NSString *subrole = subroleValue ? CFBridgingRelease(subroleValue) : nil;
    // Application identities are taken from URL attributes, not labels or activation policy.
    if ([subrole isEqual:@"AXApplicationDockItem"] || [role isEqual:@"AXImage"] || [role isEqual:@"AXButton"]) {
      CFTypeRef urlValue = NULL;
      AXUIElementCopyAttributeValue(element, CFSTR("AXURL"), &urlValue);
      id url = urlValue ? CFBridgingRelease(urlValue) : nil;
      NSString *file = [url isKindOfClass:NSURL.class] && [url isFileURL] ? [[url path] stringByResolvingSymlinksInPath] : nil;
      [rows addObject:@{ @"element": object, @"application": @([subrole isEqual:@"AXApplicationDockItem"]), @"url": file ?: NSNull.null }];
    } else {
      [rows addObject:@{ @"element": object, @"application": @NO, @"url": NSNull.null }];
    }
  }
  if (!current(original)) *complete = NO;
  CFRelease(root);
  return rows;
}
- (NSDictionary *)inventory:(NSArray *)rows complete:(BOOL)complete {
  NSString *control = [NSBundle.mainBundle.bundleURL.path stringByResolvingSymlinksInPath];
  NSUInteger positive = 0, managed = 0, candidates = 0;
  for (NSDictionary *row in rows) {
    if (![row[@"application"] boolValue]) continue;
    candidates++;
    NSString *url = row[@"url"];
    if (![url isKindOfClass:NSString.class]) { complete = NO; continue; }
    if ([url isEqual:control]) positive++;
    for (NSDictionary *target in self.targets) if ([url isEqual:target[@"bundle"]]) { managed++; break; }
  }
  return @{ @"coverage": complete && positive && candidates ? @"OBSERVED" : @"UNVERIFIED", @"positiveControlIcons": @(positive), @"managedIcons": @(managed), @"candidateCount": @(candidates) };
}
// Read the exact focused AX container owned by the same current Dock process.
// A structural candidate is evidence only: no undocumented role/label becomes switcher authority.
- (NSDictionary *)focusedContainer:(NSArray *)baseline {
  NSArray *docks = [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.apple.dock"];
  if (docks.count != 1) return @{ @"authenticated": @NO };
  pid_t pid = [docks[0] processIdentifier];
  NSDictionary *birth = identity(pid);
  if (!birth) return @{ @"authenticated": @NO };
  AXUIElementRef root = AXUIElementCreateApplication(pid);
  AXUIElementSetMessagingTimeout(root, 0.05);
  BOOL complete = YES;
  id focus = attribute(root, kAXFocusedUIElementAttribute, &complete);
  CFRelease(root);
  if (!complete || !focus || CFGetTypeID((__bridge CFTypeRef)focus) != AXUIElementGetTypeID()) return @{ @"authenticated": @NO };
  NSMutableArray *chain = [NSMutableArray array];
  id selected = focus;
  for (NSUInteger depth = 0; selected && depth < 16; depth++) {
    AXUIElementRef element = (__bridge AXUIElementRef)selected;
    pid_t owner = 0;
    if (AXUIElementGetPid(element, &owner) != kAXErrorSuccess || owner != pid) return @{ @"authenticated": @NO };
    for (id prior in chain) if (CFEqual((__bridge CFTypeRef)prior, (__bridge CFTypeRef)selected)) return @{ @"authenticated": @NO };
    [chain addObject:selected];
    AXUIElementSetMessagingTimeout(element, 0.05);
    CFTypeRef parent = NULL;
    AXError status = AXUIElementCopyAttributeValue(element, kAXParentAttribute, &parent);
    if (status == kAXErrorAttributeUnsupported || status == kAXErrorNoValue) break;
    if (status != kAXErrorSuccess || !parent) return @{ @"authenticated": @NO };
    selected = CFBridgingRelease(parent);
    if (CFGetTypeID((__bridge CFTypeRef)selected) != AXUIElementGetTypeID()) return @{ @"authenticated": @NO };
  }
  BOOL newElement = NO;
  for (id original in chain) {
    BOOL existed = NO;
    for (NSDictionary *row in baseline) if (CFEqual((__bridge CFTypeRef)original, (__bridge CFTypeRef)row[@"element"])) { existed = YES; break; }
    if (!existed) newElement = YES;
  }
  return @{ @"authenticated": @NO, @"focusedDockChainObserved": @(current(birth) && chain.count && chain.count < 16), @"newFocusedElementObserved": @(newElement), @"focusedDepth": @(chain.count) };
}
- (NSDictionary *)switcher:(NSArray *)baseline complete:(BOOL)baseComplete {
  if (!self.interaction || !AXIsProcessTrusted() || !CGPreflightPostEventAccess() ||
      NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != getpid() ||
      ((CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState) | CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState)) & (kCGEventFlagMaskCommand | kCGEventFlagMaskControl | kCGEventFlagMaskAlternate | kCGEventFlagMaskShift))) return @{ @"coverage": @"UNVERIFIED", @"reason": @"SWITCHER_ACCESS_OR_OWNED_FOREGROUND_UNAVAILABLE" };
  ProbeState state = {0}; arc4random_buf(&state.tag, sizeof(state.tag)); if (!state.tag) state.tag = 1;
  CGEventMask mask = CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp) | CGEventMaskBit(kCGEventFlagsChanged) | CGEventMaskBit(kCGEventLeftMouseDown) | CGEventMaskBit(kCGEventRightMouseDown) | CGEventMaskBit(kCGEventScrollWheel) | CGEventMaskBit(kCGEventMouseMoved) | CGEventMaskBit(kCGEventLeftMouseDragged) | CGEventMaskBit(kCGEventRightMouseDragged);
  CFMachPortRef tap = CGEventTapCreate(kCGHIDEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly, mask, observe_probe, &state);
  if (!tap) return @{ @"coverage": @"UNVERIFIED", @"reason": @"SWITCHER_ORIGINAL_INPUT_OBSERVER_UNAVAILABLE" };
  CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(NULL, tap, 0);
  if (!source) { CFRelease(tap); return @{ @"coverage": @"UNVERIFIED", @"reason": @"SWITCHER_ORIGINAL_INPUT_OBSERVER_UNAVAILABLE" }; }
  CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
  CGEventTapEnable(tap, true);
  CGKeyCode codes[] = {55, 48, 48, 53, 53, 48, 55};
  bool downs[] = {true, true, false, true, false, false, false};
  CGEventRef originals[7] = {0};
  BOOL admitted = YES, complete = NO, posted = NO;
  NSDictionary *result = @{ @"coverage": @"UNVERIFIED", @"reason": @"SWITCHER_ORIGINAL_EVENT_UNAVAILABLE" };
  NSUInteger activationStart = self.activations.count;
  @try {
    for (int i = 0; i < 7; i++) {
      originals[i] = CGEventCreateKeyboardEvent(NULL, codes[i], downs[i]);
      if (!originals[i]) { admitted = NO; break; }
      CGEventSetIntegerValueField(originals[i], kCGEventSourceUserData, (int64_t)state.tag);
      CGEventSetFlags(originals[i], i == 6 ? 0 : kCGEventFlagMaskCommand);
    }
    if (admitted && NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == getpid() && !((CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState) | CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState)) & (kCGEventFlagMaskCommand | kCGEventFlagMaskControl | kCGEventFlagMaskAlternate | kCGEventFlagMaskShift))) {
      posted = YES;
      for (int i = 0; i < 3; i++) CGEventPost(kCGHIDEventTap, originals[i]);
      CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.25, false);
      NSArray *after = [self dockTree:&complete];
      NSMutableArray *added = [NSMutableArray array];
      for (NSDictionary *row in after) {
        BOOL existed = NO;
        for (NSDictionary *old in baseline) if (CFEqual((__bridge CFTypeRef)old[@"element"], (__bridge CFTypeRef)row[@"element"])) { existed = YES; break; }
        if (!existed) { NSMutableDictionary *projected = [row mutableCopy]; projected[@"application"] = @YES; [added addObject:projected]; }
      }
      NSMutableDictionary *probe = [[self inventory:added complete:baseComplete && complete] mutableCopy];
      probe[@"probeCoverage"] = probe[@"coverage"];
      NSDictionary *focused = [self focusedContainer:baseline];
      probe[@"focusedDockChainObserved"] = focused[@"focusedDockChainObserved"] ?: @NO;
      probe[@"newFocusedElementObserved"] = focused[@"newFocusedElementObserved"] ?: @NO;
      probe[@"focusedDepth"] = focused[@"focusedDepth"] ?: @0;
      // New Dock AX elements alone cannot authenticate the macOS switcher container.
      // Preserve actual probe counts, but never turn that heuristic into switcher absence proof.
      probe[@"coverage"] = @"UNVERIFIED";
      probe[@"reason"] = @"SWITCHER_CONTAINER_NOT_AUTHENTICATED";
      result = probe;
    }
  } @finally {
    // These originals are captured before the first effect. Escape precedes Command release.
    if (posted) for (int i = 3; i < 7; i++) if (originals[i]) CGEventPost(kCGHIDEventTap, originals[i]);
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.25, false);
    for (int i = 0; i < 7; i++) if (originals[i]) CFRelease(originals[i]);
    CFRunLoopRemoveSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
    CFMachPortInvalidate(tap); CFRelease(source); CFRelease(tap);
  }
  BOOL foreignActivation = NO;
  for (NSUInteger i = activationStart; i < self.activations.count; i++) if ([self.activations[i][@"pid"] intValue] != getpid()) foreignActivation = YES;
  BOOL released = posted && !state.unknown && state.releases == 7 && !(CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState) & kCGEventFlagMaskCommand);
  NSMutableDictionary *observed = [result mutableCopy];
  observed[@"ownedReleasesObserved"] = @(released);
  if (!released || state.interference || foreignActivation || self.activationOverflow || NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != getpid()) {
    observed[@"coverage"] = @"UNVERIFIED"; observed[@"reason"] = @"SWITCHER_INTERFERENCE_OR_RELEASE_UNKNOWN";
  }
  return observed;
}
- (void)command:(NSDictionary *)command {
  NSString *operation = command[@"operation"];
  id request = command[@"requestId"];
  if (![request isKindOfClass:NSString.class] || [request length] > 128) { emit(@{ @"error": @"ORIGINAL_UI_REQUEST_UNKNOWN" }); return; }
  if ([operation isEqual:@"activate-control"] && self.interaction) {
    if (!self.window) {
      [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
      self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 300, 160) styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
      self.window.releasedWhenClosed = NO;
      self.window.title = @"DorkOS browser presence positive control";
      [self.window center]; [self.window makeKeyAndOrderFront:nil];
      [NSApp activateIgnoringOtherApps:YES];
    }
    emit(@{ @"requestId": request, @"control": identity(getpid()) ?: NSNull.null }); return;
  }
  if ([operation isEqual:@"sample"] || [operation isEqual:@"sample-owned"] || [operation isEqual:@"sample-runtime-owned"]) {
    NSArray *targets = command[@"targets"];
    if (![targets isKindOfClass:NSArray.class] || targets.count > 128) { emit(@{ @"requestId": request, @"error": @"ORIGINAL_UI_TARGETS_UNKNOWN" }); return; }
    BOOL runtimeOwned = [operation isEqual:@"sample-runtime-owned"];
    NSString *runtimeRoot = command[@"runtimeRoot"];
    if (runtimeOwned && (![runtimeRoot isKindOfClass:NSString.class] || !runtimeRoot.isAbsolutePath || runtimeRoot.length > 4096 || ![runtimeRoot isEqual:runtimeRoot.stringByStandardizingPath])) { emit(@{ @"requestId": request, @"error": @"ORIGINAL_UI_RUNTIME_ROOT_REQUIRED" }); return; }
    NSString *runtimePrefix = runtimeOwned ? [runtimeRoot stringByAppendingString:@"/"] : nil;
    BOOL qualified = YES;
    NSMutableArray *originals = [NSMutableArray array];
    NSMutableArray *originalCohort = [NSMutableArray array];
    NSMutableArray *qualifiedTargets = [NSMutableArray array];
    NSMutableSet *pids = [NSMutableSet set];
    for (id rawTarget in targets) {
      if (![rawTarget isKindOfClass:NSDictionary.class]) { qualified = NO; break; }
      NSDictionary *target = rawTarget;
      if (![target[@"pid"] isKindOfClass:NSNumber.class] || [target[@"pid"] longLongValue] <= 0 || [target[@"pid"] longLongValue] > INT_MAX || ![target[@"birth"] isKindOfClass:NSString.class] || [pids containsObject:target[@"pid"]]) { qualified = NO; break; }
      [pids addObject:target[@"pid"]];
      NSDictionary *fact = @{ @"pid": target[@"pid"] ?: NSNull.null, @"birth": target[@"birth"] ?: NSNull.null };
      // Constructor-owned birth census only. Read paths for these exact subjects,
      // never enumerate personal applications or infer their content.
      [originalCohort addObject:fact];
      if (!current(fact)) { qualified = NO; break; }
      NSString *actual = executable([fact[@"pid"] intValue]);
      if (!current(fact) || !actual) { qualified = NO; break; }
      if (runtimeOwned && ![actual hasPrefix:runtimePrefix]) continue;
      NSString *expected = target[@"executable"], *bundle = target[@"bundle"];
      NSString *actualBundle = [actual stringByDeletingLastPathComponent];
      while (actualBundle.length > 1 && ![actualBundle.pathExtension isEqual:@"app"]) actualBundle = [actualBundle stringByDeletingLastPathComponent];
      // Runtime support tools remain in the birth census but are not managed app UI subjects.
      if (runtimeOwned && ![actualBundle.pathExtension isEqual:@"app"]) continue;
      if ([operation isEqual:@"sample-owned"] || runtimeOwned) {
        expected = actual; bundle = actualBundle;
        target = @{ @"pid": fact[@"pid"], @"birth": fact[@"birth"],
                    @"executable": actual ?: @"", @"bundle": actualBundle ?: @"" };
      }
      if (!current(fact) || ![expected isKindOfClass:NSString.class] || ![bundle isKindOfClass:NSString.class] || ![expected isEqual:actual] || ![bundle isEqual:actualBundle] || ![actualBundle.pathExtension isEqual:@"app"] || (runtimeOwned && ![actualBundle hasPrefix:runtimePrefix])) qualified = NO;
      [originals addObject:fact];
      [qualifiedTargets addObject:target];
    }
    self.targets = qualified ? qualifiedTargets : @[];
    BOOL complete = NO;
    NSArray *rows = [self dockTree:&complete];
    NSDictionary *dock = [self inventory:rows complete:qualified && complete];
    NSDictionary *switcher = [command[@"probeSwitcher"] boolValue] ? [self switcher:rows complete:qualified && complete] : @{ @"coverage": @"UNVERIFIED", @"reason": @"SWITCHER_NOT_PROBED" };
    for (NSDictionary *fact in originalCohort) if (!current(fact)) qualified = NO;
    NSUInteger steals = 0; BOOL foregroundKnown = !self.activationOverflow;
    for (NSDictionary *event in self.activations) {
      if (event[@"unknown"] || event[@"overflow"]) foregroundKnown = NO;
      for (NSDictionary *fact in originals) if ([event isEqual:fact]) steals++;
    }
    pid_t frontPid = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    NSDictionary *front = identity(frontPid);
    if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != frontPid) foregroundKnown = NO;
    for (NSDictionary *fact in originals) if ([front isEqual:fact]) steals++;
    emit(@{ @"requestId": request, @"control": identity(getpid()) ?: NSNull.null, @"subjects": @(runtimeOwned ? qualifiedTargets.count : targets.count), @"birthsQualified": @(qualified), @"dock": dock, @"switcher": switcher, @"foreground": @{ @"coverage": foregroundKnown && front ? @"OBSERVED" : @"UNVERIFIED", @"managedActivations": @(steals), @"frontmost": front ?: NSNull.null } });
    return;
  }
  if ([operation isEqual:@"close"]) {
    [self.window close]; self.window = nil;
    [NSWorkspace.sharedWorkspace.notificationCenter removeObserver:self.activationObserver];
    emit(@{ @"requestId": request, @"closed": @YES });
    [NSApp terminate:nil]; return;
  }
  emit(@{ @"requestId": request, @"error": @"ORIGINAL_UI_OPERATION_REFUSED" });
}
@end
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 2 || strcmp(argv[1], "--explicit-fixture-interaction") != 0) return 2;
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    PresenceObserver *observer = [PresenceObserver new]; observer.interaction = YES;
    // Cancellation queues behind the bounded synchronous probe, whose finally observes key release.
    // Only this original helper owns this handler and its own control window.
    signal(SIGTERM, SIG_IGN);
    dispatch_source_t cancellation = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(cancellation, ^{ [observer.window close]; [NSWorkspace.sharedWorkspace.notificationCenter removeObserver:observer.activationObserver]; [NSApp terminate:nil]; });
    dispatch_resume(cancellation);
    emit(@{ @"ready": @YES, @"control": identity(getpid()) ?: NSNull.null });
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      char line[65538];
      while (fgets(line, sizeof(line), stdin)) {
        size_t length = strlen(line);
        if (!length || length > 65536 || line[length - 1] != '\n') break;
        NSData *data = [NSData dataWithBytes:line length:length];
        NSDictionary *command = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        if (![command isKindOfClass:NSDictionary.class]) break;
        dispatch_sync(dispatch_get_main_queue(), ^{ [observer command:command]; });
      }
      dispatch_async(dispatch_get_main_queue(), ^{ [observer.window close]; [NSWorkspace.sharedWorkspace.notificationCenter removeObserver:observer.activationObserver]; [NSApp terminate:nil]; });
    });
    [NSApp run];
    dispatch_source_cancel(cancellation);
  } return 0;
}
